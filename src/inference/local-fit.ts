import { LOCAL_MIN_CONTEXT_LENGTH } from "./context-policy.js"
import { availableModelMemory, type HardwareProbe, inferenceMemoryBudget } from "./hardware.js"
import {
  type LocalAttentionSpec,
  type LocalModelSpec,
  localModelForHardware,
  localModelWeightBytes,
} from "./local-catalog.js"

// The pinned llama.cpp estimator reports roughly 1.1 GiB of compute buffers for
// the largest-context catalog model. Keep additional margin because graph memory
// is architecture- and backend-dependent; llama.cpp remains authoritative at load.
const RUNTIME_OVERHEAD_BYTES = 1.5 * 1024 ** 3
const KV_ELEMENT_BYTES = 4 // f16 key + f16 value
const CONTEXT_ALIGNMENT = 1_024

export type LocalModelFit = {
  model: LocalModelSpec
  available: boolean
  contextLength: number
  memoryRequiredBytes: number
  /** The pool the fit was sized against: the GPU budget when resident there, else host memory. */
  memoryAvailableBytes: number
  /** The minimum context exceeds the GPU budget, so some layers run on the CPU. */
  requiresCpuOffload: boolean
}

export function fitLocalModel(model: LocalModelSpec, hardware: HardwareProbe): LocalModelFit {
  const selectedModel = localModelForHardware(model, hardware)
  const hostBytes = availableModelMemory(hardware)
  const gpuBytes = inferenceMemoryBudget(hardware).gpuMemoryBudgetBytes
  if (gpuBytes === undefined) return fitWithinMemory(selectedModel, hostBytes)

  // Unified memory is one pool the GPU may only partly wire. A dedicated GPU streams its own
  // layers from the mapped file, so host RAM only has to hold the layers that spill to the CPU.
  const gpuFit = fitWithinMemory(
    selectedModel,
    hardware.unifiedMemory ? Math.min(hostBytes, gpuBytes) : gpuBytes,
  )
  if (gpuFit.available) return gpuFit

  // Like llama.cpp's fitter, reduce context to the minimum before spilling layers to the CPU.
  // Manual selection remains available, but this is not a GPU recommendation.
  const hybridBytes = hardware.unifiedMemory ? hostBytes : gpuBytes + hostBytes
  const available = gpuFit.memoryRequiredBytes <= hybridBytes
  return { ...gpuFit, available, memoryAvailableBytes: hybridBytes, requiresCpuOffload: available }
}

function fitWithinMemory(model: LocalModelSpec, memoryAvailableBytes: number): LocalModelFit {
  const minRequired = memoryRequiredFor(model, LOCAL_MIN_CONTEXT_LENGTH)
  const minimum: LocalModelFit = {
    model,
    available: false,
    contextLength: LOCAL_MIN_CONTEXT_LENGTH,
    memoryRequiredBytes: minRequired,
    memoryAvailableBytes,
    requiresCpuOffload: false,
  }
  if (minRequired > memoryAvailableBytes) return minimum

  // Memory grows monotonically with context, so binary search the largest fitting
  // context and align it down; the minimum is already aligned.
  let low = LOCAL_MIN_CONTEXT_LENGTH
  let high = model.nativeContextLength
  while (low < high) {
    const mid = Math.ceil((low + high + 1) / 2)
    if (memoryRequiredFor(model, mid) <= memoryAvailableBytes) low = mid
    else high = mid - 1
  }
  const contextLength =
    low >= model.nativeContextLength
      ? model.nativeContextLength
      : Math.floor(low / CONTEXT_ALIGNMENT) * CONTEXT_ALIGNMENT
  return {
    ...minimum,
    available: true,
    contextLength,
    memoryRequiredBytes: memoryRequiredFor(model, contextLength),
  }
}

export function memoryRequiredFor(model: LocalModelSpec, contextLength: number) {
  return (
    localModelWeightBytes(model) +
    kvCacheBytes(model.attention, contextLength) +
    RUNTIME_OVERHEAD_BYTES
  )
}

function kvCacheBytes(attention: LocalAttentionSpec, contextLength: number) {
  return attention.groups.reduce((total, group) => {
    const tokens =
      group.window === undefined ? contextLength : Math.min(contextLength, group.window)
    const bytesPerTokenPerLayer =
      group.bytesPerTokenPerLayer ?? group.kvHeads * group.headDim * KV_ELEMENT_BYTES
    return total + group.layers * bytesPerTokenPerLayer * tokens
  }, 0)
}

export function formatMemoryLabel(bytes: number) {
  const gib = bytes / 1024 ** 3
  return `${gib >= 10 ? Math.round(gib) : gib.toFixed(1).replace(/\.0$/, "")} GB`
}
