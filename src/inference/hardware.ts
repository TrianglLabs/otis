import { execFile } from "node:child_process"
import { totalmem } from "node:os"
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
  gpuMemoryFreeBytes?: number
  gpuDeviceCount?: number
  backend: HardwareBackend
  unifiedMemory: boolean
}

export type InferenceMemoryBudget = {
  availableBytes: number
  deviceHeadroomBytes: number
}

export type HardwareDetectOptions = {
  env?: {
    platform?: NodeJS.Platform
    arch?: string
    totalMemoryBytes?: number
  }
  nvidiaSmi?: () => Promise<string | undefined>
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

  const nvidia = await readNvidiaMemory(options.nvidiaSmi ?? defaultNvidiaSmi)
  if (nvidia) {
    return {
      platform,
      arch,
      totalMemoryBytes,
      gpuMemoryBytes: nvidia.totalBytes,
      ...(nvidia.freeBytes !== undefined ? { gpuMemoryFreeBytes: nvidia.freeBytes } : {}),
      gpuDeviceCount: nvidia.deviceCount,
      backend: platform === "linux" ? "vulkan" : "cpu",
      unifiedMemory: false,
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

export function availableInferenceMemory(hardware: HardwareProbe) {
  return inferenceMemoryBudget(hardware).availableBytes
}

export function inferenceMemoryBudget(hardware: HardwareProbe): InferenceMemoryBudget {
  const deviceHeadroomBytes = roundedHeadroom(
    hardware.unifiedMemory || hardware.backend === "cpu" ? reservedSystemMemory(hardware) : GIBIBYTE,
  )
  const deviceMemoryBytes =
    hardware.backend !== "cpu" && hardware.gpuMemoryBytes && hardware.gpuMemoryBytes > 0
      ? hardware.gpuMemoryBytes
      : hardware.totalMemoryBytes
  const deviceCount = hardware.unifiedMemory || hardware.backend === "cpu" ? 1 : (hardware.gpuDeviceCount ?? 1)
  return {
    availableBytes: Math.max(0, deviceMemoryBytes - deviceHeadroomBytes * deviceCount),
    deviceHeadroomBytes,
  }
}

/**
 * Memory available to a new inference process right now. Capacity checks use
 * `availableInferenceMemory`; this value is advisory because another Otis
 * server may release its VRAM before the next model starts.
 */
export function currentlyAvailableInferenceMemory(hardware: HardwareProbe) {
  const budget = inferenceMemoryBudget(hardware)
  if (!hardware.unifiedMemory && hardware.backend !== "cpu" && hardware.gpuMemoryFreeBytes !== undefined) {
    const deviceCount = hardware.gpuDeviceCount ?? 1
    return Math.min(
      budget.availableBytes,
      Math.max(0, hardware.gpuMemoryFreeBytes - budget.deviceHeadroomBytes * deviceCount),
    )
  }
  return budget.availableBytes
}

function reservedSystemMemory(hardware: HardwareProbe) {
  if (hardware.unifiedMemory) return Math.max(3 * GIBIBYTE, hardware.totalMemoryBytes * 0.15)
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
      .map((line) => line.split(",").map((value) => Number.parseFloat(value.trim())))
      .filter((values) => Number.isFinite(values[0]) && Number(values[0]) > 0)
    if (devices.length === 0) return undefined

    const totalMiB = devices.reduce((sum, values) => sum + Number(values[0]), 0)
    const hasFreeForEveryDevice = devices.every((values) => Number.isFinite(values[1]) && Number(values[1]) >= 0)
    const freeMiB = hasFreeForEveryDevice
      ? devices.reduce((sum, values) => sum + Math.min(Number(values[0]), Number(values[1])), 0)
      : undefined
    return {
      totalBytes: Math.round(totalMiB * 1024 * 1024),
      ...(freeMiB !== undefined ? { freeBytes: Math.round(freeMiB * 1024 * 1024) } : {}),
      deviceCount: devices.length,
    }
  } catch {
    return undefined
  }
}

async function defaultNvidiaSmi() {
  try {
    const result = await execFileAsync(
      "nvidia-smi",
      ["--query-gpu=memory.total,memory.free", "--format=csv,noheader,nounits"],
      { timeout: 2_000 },
    )
    return result.stdout
  } catch {
    return undefined
  }
}
