import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { access, readdir, readFile } from "node:fs/promises"
import { totalmem } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const MEBIBYTE = 1024 ** 2
const GIBIBYTE = 1024 ** 3

export type HardwareBackend = "metal" | "vulkan" | "cpu"

export type HardwareProbe = {
  platform: NodeJS.Platform
  arch: string
  totalMemoryBytes: number
  gpuMemoryBytes?: number
  backend: HardwareBackend
  unifiedMemory: boolean
}

export type InferenceMemoryBudget = {
  deviceHeadroomBytes: number
}

export type HardwareDetectOptions = {
  env?: {
    platform?: NodeJS.Platform
    arch?: string
    totalMemoryBytes?: number
  }
  nvidiaSmi?: () => Promise<string | undefined>
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
      gpuMemoryBytes: totalMemoryBytes,
      backend: "metal",
      unifiedMemory: true,
    }
  }

  if (platform === "linux") {
    const nvidia = await readNvidiaMemory(options.nvidiaSmi ?? defaultNvidiaSmi)
    if (nvidia) {
      return {
        platform,
        arch,
        totalMemoryBytes,
        gpuMemoryBytes: nvidia.totalBytes,
        backend: "vulkan",
        unifiedMemory: false,
      }
    }

    const graphics = await readLinuxGraphics(options.linuxGraphics ?? defaultLinuxGraphics)
    if (graphics) {
      return {
        platform,
        arch,
        totalMemoryBytes,
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
    backend: "cpu",
    unifiedMemory: false,
  }
}

/** Host memory available to run a model, including CPU layers used by hybrid offload. */
export function availableModelMemory(hardware: HardwareProbe) {
  return Math.max(0, hardware.totalMemoryBytes - roundedHeadroom(reservedSystemMemory(hardware)))
}

export function inferenceMemoryBudget(hardware: HardwareProbe): InferenceMemoryBudget {
  const hasDedicatedMemory =
    !hardware.unifiedMemory &&
    hardware.backend !== "cpu" &&
    hardware.gpuMemoryBytes !== undefined &&
    hardware.gpuMemoryBytes > 0
  const deviceHeadroomBytes = roundedHeadroom(hasDedicatedMemory ? GIBIBYTE : reservedSystemMemory(hardware))
  return { deviceHeadroomBytes }
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
      .map((line) => Number.parseFloat(line))
      .filter((value) => Number.isFinite(value) && value > 0)
    if (devices.length === 0) return undefined

    const totalMiB = devices.reduce((sum, value) => sum + value, 0)
    return { totalBytes: Math.round(totalMiB * 1024 * 1024) }
  } catch {
    return undefined
  }
}

async function defaultNvidiaSmi() {
  try {
    const result = await execFileAsync("nvidia-smi", ["--query-gpu=memory.total", "--format=csv,noheader,nounits"], {
      timeout: 2_000,
    })
    return result.stdout
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
    return totalBytes === undefined ? {} : { totalBytes }
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
