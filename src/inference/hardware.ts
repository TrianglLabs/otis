import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { access, readdir, readFile, readlink } from "node:fs/promises"
import { release, totalmem } from "node:os"
import { basename, dirname, join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const MEBIBYTE = 1024 ** 2
const GIBIBYTE = 1024 ** 3
/** Apple silicon pages; Metal rounds its working set up to one. */
const METAL_PAGE_BYTES = 16_384
/** cgroup v1 reports "no limit" as a near-2^63 byte count. */
const UNLIMITED_CGROUP_BYTES = 2 ** 60
const NVIDIA_SMI_FIELDS = ["index", "uuid", "name", "memory.total"]
const NVIDIA_SMI_DETAIL_FIELDS = ["driver_version", "compute_cap", "mig.mode.current"]

export type HardwareBackend = "metal" | "cuda" | "vulkan" | "cpu"
export type CudaVersion = "12.8" | "13.3"
export type GpuVendor = "nvidia" | "amd" | "intel"

export type HardwareProbe = {
  platform: NodeJS.Platform
  arch: string
  /** Host memory, capped by the process's cgroup limit on Linux. */
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
  /** The vendor shared by the budgeted GPUs; Intel integrated graphics keep the CPU order. */
  gpuVendor?: GpuVendor
  unifiedMemory: boolean
  /** Caveats about the probe, such as a MIG GPU whose partitions could not be read. */
  notes?: string[]
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
    /** Kernel release, as `os.release()`: Darwin 25 is macOS 26. */
    release?: string
  }
  /** Process variables that restrict device visibility, such as CUDA_VISIBLE_DEVICES. */
  variables?: NodeJS.ProcessEnv
  /** `nvidia-smi --query-gpu` CSV rows: index, uuid, name, memory, then driver, compute, MIG. */
  nvidiaSmi?: () => Promise<string | undefined>
  /** The MIG partitions of one GPU, with memory when nvidia-smi can read the partition. */
  migDevices?: (gpu: NvidiaDevice) => Promise<readonly MigDevice[]>
  /** The memory limit of this process's cgroup, when one applies. */
  cgroupMemoryLimitBytes?: () => Promise<number | undefined>
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

type NvidiaDevice = {
  index: number
  uuid: string
  name: string
  /** MiB; NaN when nvidia-smi reports it unavailable. */
  memory: number
  driver: string
  compute: number
  mig: boolean
}

type MigDevice = { uuid: string; memoryMiB?: number }

export async function detectHardware(options: HardwareDetectOptions = {}): Promise<HardwareProbe> {
  const platform = options.env?.platform ?? process.platform
  const arch = options.env?.arch ?? process.arch
  let totalMemoryBytes = options.env?.totalMemoryBytes ?? totalmem()
  if (platform === "linux") {
    const limit = await (options.cgroupMemoryLimitBytes ?? defaultCgroupMemoryLimit)().catch(
      () => undefined,
    )
    if (limit !== undefined) totalMemoryBytes = Math.min(totalMemoryBytes, limit)
  }
  const host = { platform, arch, totalMemoryBytes, unifiedMemory: false }
  if (platform === "darwin" && arch === "arm64") {
    // Metal wires at most recommendedMaxWorkingSetSize unless the user raised iogpu.wired_limit_mb.
    // Measured at 78% of RAM rounded up to a page on macOS 26 and later (Darwin 25+): an M2 Max
    // with 32 GiB on macOS 26.5.2 reports 26,800,603,136 bytes and an M4 Max with 36 GiB on
    // macOS 27.0 reports 30,150,672,384 (tests/inference/hardware.test.ts). Smaller Macs and
    // older releases keep the reported two thirds up to 36 GiB and three quarters above.
    const wired = await (options.metalWiredLimitMiB ?? defaultMetalWiredLimit)().catch(
      () => undefined,
    )
    const darwin = Number.parseInt(options.env?.release ?? release(), 10)
    const [share, of] = totalMemoryBytes <= 36 * GIBIBYTE ? [2, 3] : [3, 4]
    const workingSet =
      darwin >= 25 && totalMemoryBytes >= 32 * GIBIBYTE
        ? Math.ceil((totalMemoryBytes * 0.78) / METAL_PAGE_BYTES) * METAL_PAGE_BYTES
        : Math.floor((totalMemoryBytes * share) / of)
    return {
      ...host,
      gpuCount: 1,
      gpuMemoryBytes: wired ? wired * MEBIBYTE : workingSet,
      backend: "metal",
      unifiedMemory: true,
    }
  }
  if (platform !== "linux") return { ...host, gpuCount: 0, backend: "cpu" }

  const nvidia = await (options.nvidiaSmi ?? defaultNvidiaSmi)().catch(() => undefined)
  const notes: string[] = []
  const gpus = (nvidia ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line): NvidiaDevice => {
      const [index, uuid = "", name = "", memory, driver = "", compute = "", mig = ""] = line
        .split(",")
        .map((field) => field.trim())
      return {
        index: Number(index),
        uuid,
        name,
        memory: Number(memory),
        driver,
        compute: Number(compute),
        mig: mig === "Enabled" || /\bMIG\b/.test(name),
      }
    })
  // A MIG GPU exposes only its partitions to CUDA; budget those when nvidia-smi can read them.
  const expanded: NvidiaDevice[] = []
  for (const gpu of gpus) {
    const partitions = gpu.mig
      ? await (options.migDevices ?? defaultMigDevices)(gpu).catch(() => [])
      : []
    if (partitions.length > 0 && partitions.every(({ memoryMiB }) => memoryMiB !== undefined)) {
      expanded.push(
        ...partitions.map(({ uuid, memoryMiB }) => ({ ...gpu, uuid, memory: Number(memoryMiB) })),
      )
      continue
    }
    if (gpu.mig) {
      notes.push(
        `GPU ${gpu.index} (${gpu.name}) is in MIG mode; its partitions could not be read, so the whole GPU was budgeted.`,
      )
    }
    expanded.push(gpu)
  }
  const devices = visibleCudaDevices(
    expanded,
    (options.variables ?? process.env).CUDA_VISIBLE_DEVICES,
  )
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
      gpuVendor: "nvidia",
      ...(notes.length ? { notes } : {}),
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
  const vendors = new Set(
    (discrete.length === 0 ? graphics : discrete).map(({ driver }): GpuVendor | undefined =>
      driver === "amdgpu" ? "amd" : driver === "i915" || driver === "xe" ? "intel" : undefined,
    ),
  )
  const [vendor] = vendors
  const gpuVendor = vendors.size === 1 && vendor ? { gpuVendor: vendor } : {}
  if (discrete.length === 0) {
    return {
      ...host,
      gpuCount: graphics.length,
      gpuMemoryBytes: totalMemoryBytes,
      backend: "vulkan",
      ...gpuVendor,
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
    ...gpuVendor,
  }
}

/**
 * The devices CUDA enumerates under CUDA_VISIBLE_DEVICES: ordinals into the nvidia-smi list, or
 * GPU-/MIG- UUID prefixes. As in the CUDA runtime, the list ends at its first entry that names
 * nothing.
 */
function visibleCudaDevices(devices: NvidiaDevice[], visible: string | undefined) {
  if (visible === undefined) return devices
  const selected: NvidiaDevice[] = []
  for (const entry of visible.split(",").map((value) => value.trim())) {
    const match = /^\d+$/.test(entry)
      ? devices[Number(entry)]
      : /^(?:GPU|MIG)-/.test(entry)
        ? devices.find((device) => device.uuid.startsWith(entry))
        : undefined
    if (!match) break
    selected.push(match)
  }
  return selected
}

/** Host memory available to run a model, including CPU layers used by hybrid offload. */
export function availableModelMemory(hardware: HardwareProbe) {
  return Math.max(0, hardware.totalMemoryBytes - systemHeadroom(hardware))
}

export function inferenceMemoryBudget(hardware: HardwareProbe): InferenceMemoryBudget {
  if (hardware.backend === "cpu") return { deviceHeadroomBytes: systemHeadroom(hardware) }
  // llama.cpp's default `--fit-target`: common_params::fit_params_target is 1024 MiB per device
  // (common/common.h), broadcast to every device whether dedicated or sharing host RAM, and
  // whether or not its driver reports capacity. Otis passes the same value to the server.
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

/**
 * Memory reserved for the OS and other applications, rounded up to whole MiB. These are Otis
 * conventions rather than measurements: a proportional share so a large host keeps room for its
 * page cache and other applications, with a floor near an idle desktop's resident set. macOS on
 * unified memory gets 15% with a 3 GiB floor because WindowServer, the kernel's wired set, and
 * the display pipeline share the pool the GPU wires from; other hosts get 10% with a 2 GiB
 * floor. llama.cpp's fitter, not this headroom, decides the final load.
 */
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
  for (const fields of [[...NVIDIA_SMI_FIELDS, ...NVIDIA_SMI_DETAIL_FIELDS], NVIDIA_SMI_FIELDS]) {
    try {
      const args = [`--query-gpu=${fields.join(",")}`, "--format=csv,noheader,nounits"]
      // Cold driver initialization without nvidia-persistenced can take several seconds.
      return (await execFileAsync("nvidia-smi", args, { timeout: 10_000 })).stdout
    } catch {
      // Try the reduced query, then report no NVIDIA devices.
    }
  }
  return undefined
}

/** `nvidia-smi -L` lists each MIG partition under its GPU; memory comes from a per-partition query. */
async function defaultMigDevices(gpu: NvidiaDevice): Promise<MigDevice[]> {
  const listing = (await execFileAsync("nvidia-smi", ["-L"], { timeout: 10_000 })).stdout
  const section = listing.split(/^(?=GPU \d+:)/m).find((block) => block.includes(gpu.uuid)) ?? ""
  const uuids = Array.from(section.matchAll(/\(UUID: (MIG-[^)]+)\)/g), ([, uuid]) => uuid)
  return await Promise.all(
    uuids.map(async (uuid) => {
      const args = ["--query-gpu=memory.total", "--format=csv,noheader,nounits", `--id=${uuid}`]
      const memoryMiB = Number(
        (await execFileAsync("nvidia-smi", args, { timeout: 10_000 })).stdout.trim(),
      )
      return Number.isFinite(memoryMiB) && memoryMiB > 0 ? { uuid, memoryMiB } : { uuid }
    }),
  )
}

/** The tightest limit from this process's cgroup to the root: v2 memory.max or v1 limit_in_bytes. */
async function defaultCgroupMemoryLimit() {
  const membership = await readFile("/proc/self/cgroup", "utf8")
  const limits: number[] = []
  for (const [pattern, root, file] of [
    [/^0::(.*)$/m, "/sys/fs/cgroup", "memory.max"],
    [/^\d+:(?:[^:]*,)?memory(?:,[^:]*)?:(.*)$/m, "/sys/fs/cgroup/memory", "memory.limit_in_bytes"],
  ] as const) {
    let path = pattern.exec(membership)?.[1]
    while (path !== undefined) {
      const value = await readFile(join(root, path, file), "utf8").catch(() => "")
      const limit = Number(value.trim())
      if (Number.isFinite(limit) && limit > 0 && limit < UNLIMITED_CGROUP_BYTES) limits.push(limit)
      path = path === "/" || path === "" ? undefined : dirname(path)
    }
  }
  return limits.length ? Math.min(...limits) : undefined
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
