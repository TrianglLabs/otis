import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { access, readdir, readFile } from "node:fs/promises"
import { totalmem } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const MEBIBYTE = 1024 ** 2
const GIBIBYTE = 1024 ** 3

export type HardwareBackend = "metal" | "cuda" | "vulkan" | "cpu"
export type CudaVersion = "12.8" | "13.3"

export type HardwareProbe = {
  platform: NodeJS.Platform
  arch: string
  totalMemoryBytes: number
  /** Number of detected GPUs, including devices whose VRAM is unknown. */
  gpuCount: number
  /** Combined GPU capacity; omitted unless every detected device reports memory. */
  gpuMemoryBytes?: number
  backend: HardwareBackend
  cudaVersion?: CudaVersion
  unifiedMemory: boolean
}

export type InferenceMemoryBudget = {
  /** Per-device margin passed to llama.cpp, which broadcasts it to every device. */
  deviceHeadroomBytes: number
  /** Aggregate dedicated VRAM after reserving headroom on every GPU. */
  gpuWeightBudgetBytes?: number
}

export type HardwareDetectOptions = {
  env?: {
    platform?: NodeJS.Platform
    arch?: string
    totalMemoryBytes?: number
  }
  nvidiaSmi?: () => Promise<string | undefined>
  glibcVersion?: () => Promise<string | undefined>
  linuxGraphics?: () => Promise<readonly LinuxGraphicsDevice[]>
}

export type LinuxGraphicsDevice = {
  memoryTotalBytes?: number
}

export async function detectHardware(options: HardwareDetectOptions = {}): Promise<HardwareProbe> {
  const platform = options.env?.platform ?? process.platform
  const arch = options.env?.arch ?? process.arch
  const totalMemoryBytes = options.env?.totalMemoryBytes ?? totalmem()
  const unifiedMemory = platform === "darwin" && arch === "arm64"
  if (unifiedMemory) {
    return {
      platform,
      arch,
      totalMemoryBytes,
      gpuCount: 1,
      gpuMemoryBytes: totalMemoryBytes,
      backend: "metal",
      unifiedMemory: true,
    }
  }

  if (platform === "linux") {
    const nvidia = await readNvidiaMemory(options.nvidiaSmi ?? defaultNvidiaSmi)
    if (nvidia) {
      const glibc = await (options.glibcVersion ?? defaultGlibcVersion)().catch(() => undefined)
      const cudaVersion = compatibleCudaVersion(arch, glibc, nvidia.devices)
      return {
        platform,
        arch,
        totalMemoryBytes,
        gpuCount: nvidia.count,
        gpuMemoryBytes: nvidia.totalBytes,
        backend: cudaVersion ? "cuda" : "vulkan",
        ...(cudaVersion ? { cudaVersion } : {}),
        unifiedMemory: false,
      }
    }

    const graphics = await readLinuxGraphics(options.linuxGraphics ?? defaultLinuxGraphics)
    if (graphics) {
      return {
        platform,
        arch,
        totalMemoryBytes,
        gpuCount: graphics.count,
        ...(graphics.totalBytes !== undefined ? { gpuMemoryBytes: graphics.totalBytes } : {}),
        backend: "vulkan",
        unifiedMemory: false,
      }
    }
  }

  return {
    platform,
    arch,
    totalMemoryBytes,
    gpuCount: 0,
    backend: "cpu",
    unifiedMemory: false,
  }
}

/** Host memory available to run a model, including CPU layers used by hybrid offload. */
export function availableModelMemory(hardware: HardwareProbe) {
  return Math.max(0, hardware.totalMemoryBytes - roundedHeadroom(reservedSystemMemory(hardware)))
}

export function inferenceMemoryBudget(hardware: HardwareProbe): InferenceMemoryBudget {
  const dedicatedGpu = !hardware.unifiedMemory && hardware.backend !== "cpu"
  // A GPU's margin does not depend on whether its driver reports VRAM capacity.
  const deviceHeadroomBytes = roundedHeadroom(dedicatedGpu ? GIBIBYTE : reservedSystemMemory(hardware))
  return {
    deviceHeadroomBytes,
    ...(dedicatedGpu && hardware.gpuMemoryBytes !== undefined
      ? { gpuWeightBudgetBytes: Math.max(0, hardware.gpuMemoryBytes - hardware.gpuCount * deviceHeadroomBytes) }
      : {}),
  }
}

function reservedSystemMemory(hardware: HardwareProbe) {
  if (hardware.platform === "darwin" && hardware.unifiedMemory) {
    return Math.max(3 * GIBIBYTE, hardware.totalMemoryBytes * 0.15)
  }
  return Math.max(2 * GIBIBYTE, hardware.totalMemoryBytes * 0.1)
}

function roundedHeadroom(bytes: number) {
  return Math.ceil(bytes / MEBIBYTE) * MEBIBYTE
}

async function readNvidiaMemory(nvidiaSmi: () => Promise<string | undefined>) {
  try {
    const output = await nvidiaSmi()
    if (!output) return undefined
    const devices = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [memory, driver = "", compute = ""] = line.split(",").map((field) => field.trim())
        return { memory: Number(memory), driver, compute: Number(compute) }
      })
    if (devices.length === 0) return undefined

    const knownMemory = devices.every(({ memory }) => Number.isFinite(memory) && memory > 0)
    const totalMiB = devices.reduce((sum, { memory }) => sum + memory, 0)
    return { count: devices.length, totalBytes: knownMemory ? Math.round(totalMiB * MEBIBYTE) : undefined, devices }
  } catch {
    return undefined
  }
}

async function defaultNvidiaSmi() {
  try {
    const result = await execFileAsync(
      "nvidia-smi",
      ["--query-gpu=memory.total,driver_version,compute_cap", "--format=csv,noheader,nounits"],
      {
        timeout: 2_000,
      },
    )
    return result.stdout
  } catch {
    // Older drivers may not expose compute_cap. Preserve their VRAM detection
    // and Vulkan selection even when CUDA compatibility cannot be established.
    try {
      const result = await execFileAsync("nvidia-smi", ["--query-gpu=memory.total", "--format=csv,noheader,nounits"], {
        timeout: 2_000,
      })
      return result.stdout
    } catch {
      return undefined
    }
  }
}

function compatibleCudaVersion(
  arch: string,
  glibc: string | undefined,
  devices: readonly { driver: string; compute: number }[],
): CudaVersion | undefined {
  // Official CUDA archives target Ubuntu 24.04. Their PTX kernels need the
  // toolkit's full driver version, not just CUDA minor-version compatibility.
  if (!glibc || !versionAtLeast(glibc, "2.39")) return undefined
  if (arch !== "x64" && arch !== "arm64") return undefined
  if (
    devices.every(({ driver, compute }) => versionAtLeast(driver, "610.43.02") && compute >= 7.5 && compute <= 12.1)
  ) {
    return "13.3"
  }
  // CUDA 12.8 includes kernels through SM 120, but not GB10's SM 121.
  if (
    arch === "x64" &&
    devices.every(({ driver, compute }) => versionAtLeast(driver, "570.211.01") && compute >= 5 && compute <= 12)
  ) {
    return "12.8"
  }
  return undefined
}

function versionAtLeast(value: string, minimum: string) {
  if (!/^\d+(?:\.\d+)*$/.test(value)) return false
  const parts = value.split(".").map(Number)
  const required = minimum.split(".").map(Number)
  for (let index = 0; index < required.length; index += 1) {
    const difference = (parts[index] ?? 0) - (required[index] ?? 0)
    if (difference !== 0) return difference > 0
  }
  return true
}

async function defaultGlibcVersion() {
  try {
    const result = await execFileAsync("getconf", ["GNU_LIBC_VERSION"], { timeout: 2_000 })
    return /^glibc (\d+(?:\.\d+)+)$/.exec(result.stdout.trim())?.[1]
  } catch {
    return undefined
  }
}

async function readLinuxGraphics(probe: () => Promise<readonly LinuxGraphicsDevice[]>) {
  try {
    const devices = await probe()
    if (devices.length === 0) return undefined
    const memory = devices.map((device) => ({
      total: positiveInteger(device.memoryTotalBytes),
    }))
    const hasMemoryForEveryDevice = memory.every(({ total }) => total !== undefined)
    const totalBytes = hasMemoryForEveryDevice ? memory.reduce((sum, { total }) => sum + (total ?? 0), 0) : undefined
    return { count: devices.length, totalBytes }
  } catch {
    return undefined
  }
}

async function defaultLinuxGraphics(): Promise<LinuxGraphicsDevice[]> {
  const drmRoot = "/sys/class/drm"
  const entries = await readdir(drmRoot, { withFileTypes: true })
  // Entries under /sys/class/drm are commonly symlinks, so the name is the
  // reliable render-node discriminator rather than Dirent.isDirectory().
  const renderNodes = entries.filter((entry) => /^renderD\d+$/.test(entry.name))
  const usableRenderNodes = []
  for (const entry of renderNodes) {
    try {
      await access(join("/dev/dri", entry.name), constants.R_OK | constants.W_OK)
      usableRenderNodes.push(entry)
    } catch {
      // A render node that this process cannot open is not a usable backend.
    }
  }
  return await Promise.all(
    usableRenderNodes.map(async (entry) => {
      const deviceRoot = join(drmRoot, entry.name, "device")
      return {
        memoryTotalBytes: await readInteger(join(deviceRoot, "mem_info_vram_total")),
      }
    }),
  )
}

async function readTrimmed(path: string) {
  try {
    return (await readFile(path, "utf8")).trim()
  } catch {
    return undefined
  }
}

async function readInteger(path: string) {
  const value = await readTrimmed(path)
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

function positiveInteger(value: number | undefined) {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : undefined
}
