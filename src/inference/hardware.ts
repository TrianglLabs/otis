import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { access, readdir, readFile, readlink } from "node:fs/promises"
import { totalmem } from "node:os"
import { basename, join } from "node:path"
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
  /**
   * Combined GPU capacity; omitted unless every detected device reports memory. With unified
   * memory this is what the GPU may wire: the Metal working set on Apple silicon, or host RAM for
   * Linux integrated graphics.
   */
  gpuMemoryBytes?: number
  backend: HardwareBackend
  cudaVersion?: CudaVersion
  /** Per-GPU compute capabilities; omitted unless all NVIDIA devices report them. */
  cudaComputeCapabilities?: readonly number[]
  unifiedMemory: boolean
}

type InferenceMemoryBudget = {
  /** Per-device margin passed to llama.cpp, which broadcasts it to every device. */
  deviceHeadroomBytes: number
  /** Aggregate GPU memory for weights, context cache, and runtime buffers, after per-GPU headroom. */
  gpuMemoryBudgetBytes?: number
}

type HardwareDetectOptions = {
  env?: {
    platform?: NodeJS.Platform
    arch?: string
    totalMemoryBytes?: number
  }
  nvidiaSmi?: () => Promise<string | undefined>
  glibcVersion?: () => Promise<string | undefined>
  linuxGraphics?: () => Promise<readonly LinuxGraphicsDevice[]>
  /** `sysctl -n iogpu.wired_limit_mb`: zero unless the user raised the Metal working set. */
  metalWiredLimitMiB?: () => Promise<number | undefined>
}

type LinuxGraphicsDevice = {
  /** Kernel driver name, such as amdgpu, i915, or xe. */
  driver?: string
  memoryTotalBytes?: number
  /** amdgpu's GTT aperture into host RAM, which dwarfs an APU's BIOS VRAM carve-out. */
  gttTotalBytes?: number
}

export async function detectHardware(options: HardwareDetectOptions = {}): Promise<HardwareProbe> {
  const platform = options.env?.platform ?? process.platform
  const arch = options.env?.arch ?? process.arch
  const totalMemoryBytes = options.env?.totalMemoryBytes ?? totalmem()
  const host = { platform, arch, totalMemoryBytes, unifiedMemory: false }
  if (platform === "darwin" && arch === "arm64") {
    // Metal wires at most recommendedMaxWorkingSetSize: two thirds of RAM up to 36 GiB and three
    // quarters above, unless the user raised iogpu.wired_limit_mb.
    const wired = await (options.metalWiredLimitMiB ?? defaultMetalWiredLimit)().catch(
      () => undefined,
    )
    const [share, of] = totalMemoryBytes <= 36 * GIBIBYTE ? [2, 3] : [3, 4]
    return {
      ...host,
      gpuCount: 1,
      gpuMemoryBytes: wired ? wired * MEBIBYTE : Math.floor((totalMemoryBytes * share) / of),
      backend: "metal",
      unifiedMemory: true,
    }
  }
  if (platform !== "linux") return { ...host, gpuCount: 0, backend: "cpu" }

  const nvidia = await (options.nvidiaSmi ?? defaultNvidiaSmi)().catch(() => undefined)
  const devices = (nvidia ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [memory, driver = "", compute = ""] = line.split(",").map((field) => field.trim())
      return { memory: Number(memory), driver, compute: Number(compute) }
    })
  if (devices.length > 0) {
    const glibc = await (options.glibcVersion ?? defaultGlibcVersion)().catch(() => undefined)
    // Official CUDA archives target Ubuntu 24.04. Their PTX kernels need the
    // toolkit's full driver version, not just CUDA minor-version compatibility.
    // CUDA 12.8 includes kernels through SM 120, but not GB10's SM 121.
    let cudaVersion: CudaVersion | undefined
    if (glibc && versionAtLeast(glibc, "2.39") && (arch === "x64" || arch === "arm64")) {
      if (
        devices.every(
          ({ driver, compute }) =>
            versionAtLeast(driver, "610.43.02") && compute >= 7.5 && compute <= 12.1,
        )
      ) {
        cudaVersion = "13.3"
      } else if (
        arch === "x64" &&
        devices.every(
          ({ driver, compute }) =>
            versionAtLeast(driver, "570.211.01") && compute >= 5 && compute <= 12,
        )
      ) {
        cudaVersion = "12.8"
      }
    }
    const knownMemory = devices.every(({ memory }) => Number.isFinite(memory) && memory > 0)
    const knownCompute = devices.every(({ compute }) => Number.isFinite(compute) && compute > 0)
    return {
      ...host,
      gpuCount: devices.length,
      gpuMemoryBytes: knownMemory
        ? Math.round(devices.reduce((sum, { memory }) => sum + memory, 0) * MEBIBYTE)
        : undefined,
      backend: cudaVersion ? "cuda" : "vulkan",
      ...(cudaVersion ? { cudaVersion } : {}),
      ...(knownCompute ? { cudaComputeCapabilities: devices.map(({ compute }) => compute) } : {}),
    }
  }

  const graphics = await (options.linuxGraphics ?? defaultLinuxGraphics)().catch(() => [])
  if (graphics.length === 0) return { ...host, gpuCount: 0, backend: "cpu" }
  // Integrated graphics share host RAM: an APU reports only its BIOS carve-out as VRAM and Intel
  // reports none. A discrete card alongside one is the device that matters for budgeting.
  const integrated = ({
    driver,
    memoryTotalBytes: vram,
    gttTotalBytes: gtt,
  }: LinuxGraphicsDevice) =>
    driver === "i915" || driver === "xe"
      ? vram === undefined
      : driver === "amdgpu" &&
        vram !== undefined &&
        vram <= 4 * GIBIBYTE &&
        gtt !== undefined &&
        gtt >= 2 * vram
  const discrete = graphics.filter((device) => !integrated(device))
  if (discrete.length === 0) {
    return {
      ...host,
      gpuCount: graphics.length,
      gpuMemoryBytes: totalMemoryBytes,
      backend: "vulkan",
      unifiedMemory: true,
    }
  }
  const memory = discrete.map((device) => device.memoryTotalBytes)
  const knownMemory = memory.every(
    (total): total is number => total !== undefined && Number.isSafeInteger(total) && total > 0,
  )
  return {
    ...host,
    gpuCount: discrete.length,
    ...(knownMemory ? { gpuMemoryBytes: memory.reduce((sum, total) => sum + total, 0) } : {}),
    backend: "vulkan",
  }
}

/** Host memory available to run a model, including CPU layers used by hybrid offload. */
export function availableModelMemory(hardware: HardwareProbe) {
  return Math.max(0, hardware.totalMemoryBytes - systemHeadroom(hardware))
}

export function inferenceMemoryBudget(hardware: HardwareProbe): InferenceMemoryBudget {
  if (hardware.backend === "cpu") return { deviceHeadroomBytes: systemHeadroom(hardware) }
  // llama.cpp's default per-device margin, whether the device is dedicated or shares host RAM,
  // and whether or not its driver reports capacity.
  const deviceHeadroomBytes = GIBIBYTE
  return {
    deviceHeadroomBytes,
    ...(hardware.gpuMemoryBytes === undefined
      ? {}
      : {
          gpuMemoryBudgetBytes: Math.max(
            0,
            hardware.gpuMemoryBytes - hardware.gpuCount * deviceHeadroomBytes,
          ),
        }),
  }
}

/** Memory reserved for the OS and other applications, rounded up to whole MiB. */
function systemHeadroom(hardware: HardwareProbe) {
  const [floor, share] =
    hardware.platform === "darwin" && hardware.unifiedMemory ? [3, 0.15] : [2, 0.1]
  return (
    Math.ceil(Math.max(floor * GIBIBYTE, hardware.totalMemoryBytes * share) / MEBIBYTE) * MEBIBYTE
  )
}

async function defaultNvidiaSmi() {
  // Older drivers may not expose compute_cap. Preserve their VRAM detection
  // and Vulkan selection even when CUDA compatibility cannot be established.
  for (const fields of ["memory.total,driver_version,compute_cap", "memory.total"]) {
    try {
      const args = [`--query-gpu=${fields}`, "--format=csv,noheader,nounits"]
      // Cold driver initialization without nvidia-persistenced can take several seconds.
      return (await execFileAsync("nvidia-smi", args, { timeout: 10_000 })).stdout
    } catch {
      // Try the reduced query, then report no NVIDIA devices.
    }
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

async function defaultMetalWiredLimit() {
  const result = await execFileAsync("sysctl", ["-n", "iogpu.wired_limit_mb"], { timeout: 2_000 })
  return Number(result.stdout.trim())
}

async function defaultGlibcVersion() {
  try {
    const result = await execFileAsync("getconf", ["GNU_LIBC_VERSION"], { timeout: 2_000 })
    return /^glibc (\d+(?:\.\d+)+)$/.exec(result.stdout.trim())?.[1]
  } catch {
    return undefined
  }
}

async function defaultLinuxGraphics(): Promise<LinuxGraphicsDevice[]> {
  const drmRoot = "/sys/class/drm"
  const entries = await readdir(drmRoot, { withFileTypes: true })
  // Entries under /sys/class/drm are commonly symlinks, so the name is the
  // reliable render-node discriminator rather than Dirent.isDirectory().
  const usableRenderNodes = []
  for (const entry of entries.filter((entry) => /^renderD\d+$/.test(entry.name))) {
    try {
      await access(join("/dev/dri", entry.name), constants.R_OK | constants.W_OK)
      usableRenderNodes.push(entry)
    } catch {
      // A render node that this process cannot open is not a usable backend.
    }
  }
  return await Promise.all(
    usableRenderNodes.map(async (entry) => {
      const device = join(drmRoot, entry.name, "device")
      const bytes = async (name: string) => {
        const value = (await readFile(join(device, name), "utf8").catch(() => "")).trim()
        const parsed = Number(value)
        return value && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
      }
      return {
        driver: await readlink(join(device, "driver"))
          .then((target) => basename(target))
          .catch(() => undefined),
        memoryTotalBytes: await bytes("mem_info_vram_total"),
        gttTotalBytes: await bytes("mem_info_gtt_total"),
      }
    }),
  )
}
