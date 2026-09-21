import { LOCAL_MIN_CONTEXT_LENGTH } from "./context-policy.js"
import { availableModelMemory, type HardwareProbe, inferenceMemoryBudget } from "./hardware.js"
import {
  LOCAL_CONTEXT_ALIGNMENT,
  type LocalAttentionSpec,
  type LocalKvGroup,
  type LocalModelSpec,
  localModelForHardware,
  localModelWeightBytes,
} from "./local-catalog.js"

// The pinned llama.cpp estimator reports roughly 1.1 GiB of compute buffers for
// the largest-context catalog model. Keep additional margin because graph memory
// is architecture- and backend-dependent; llama.cpp remains authoritative at load.
const RUNTIME_OVERHEAD_BYTES = 1.5 * 1024 ** 3
const KV_ELEMENT_BYTES = 4 // f16 key + f16 value

export type LocalModelFit = {
  model: LocalModelSpec
  available: boolean
  contextLength: number
  memoryRequiredBytes: number
  memoryAvailableBytes: number
  /** The minimum context fits host RAM but exceeds the known dedicated GPU budget. */
  requiresCpuOffload: boolean
}

export function fitLocalModel(model: LocalModelSpec, hardware: HardwareProbe): LocalModelFit {
  const selectedModel = localModelForHardware(model, hardware)
  const memoryAvailableBytes = availableModelMemory(hardware)
  const hostFit = fitLocalModelWithinMemory(selectedModel, memoryAvailableBytes)
  const gpuMemoryBudgetBytes = inferenceMemoryBudget(hardware).gpuMemoryBudgetBytes
  if (!hostFit.available || gpuMemoryBudgetBytes === undefined) return hostFit

  // Keep host fit as the availability gate, but budget the entire inference footprint
  // in VRAM before recommending a GPU model or estimating its usable context.
  const gpuFit = fitLocalModelWithinMemory(selectedModel, Math.min(memoryAvailableBytes, gpuMemoryBudgetBytes))
  if (gpuFit.available) return gpuFit

  // Like llama.cpp's fitter, reduce context to the minimum before spilling layers to RAM.
  // Manual selection remains available, but this is not a GPU recommendation.
  return {
    ...hostFit,
    contextLength: LOCAL_MIN_CONTEXT_LENGTH,
    memoryRequiredBytes: memoryRequiredFor(selectedModel, LOCAL_MIN_CONTEXT_LENGTH),
    requiresCpuOffload: true,
  }
}

export function fitLocalModelWithinMemory(model: LocalModelSpec, memoryAvailableBytes: number): LocalModelFit {
  if (!Number.isFinite(memoryAvailableBytes) || memoryAvailableBytes < 0) {
    throw new Error("Available inference memory must be a non-negative number.")
  }
  const minRequired = memoryRequiredFor(model, LOCAL_MIN_CONTEXT_LENGTH)
  if (minRequired > memoryAvailableBytes) {
    return {
      model,
      available: false,
      contextLength: LOCAL_MIN_CONTEXT_LENGTH,
      memoryRequiredBytes: minRequired,
      memoryAvailableBytes,
      requiresCpuOffload: false,
    }
  }

  const nativeRequired = memoryRequiredFor(model, model.nativeContextLength)
  if (nativeRequired <= memoryAvailableBytes) {
    return {
      model,
      available: true,
      contextLength: model.nativeContextLength,
      memoryRequiredBytes: nativeRequired,
      memoryAvailableBytes,
      requiresCpuOffload: false,
    }
  }

  const contextLength = alignContext(largestFittingContext(model, memoryAvailableBytes), model.nativeContextLength)
  if (contextLength < LOCAL_MIN_CONTEXT_LENGTH || memoryRequiredFor(model, contextLength) > memoryAvailableBytes) {
    return {
      model,
      available: false,
      contextLength: LOCAL_MIN_CONTEXT_LENGTH,
      memoryRequiredBytes: minRequired,
      memoryAvailableBytes,
      requiresCpuOffload: false,
    }
  }

  return {
    model,
    available: true,
    contextLength,
    memoryRequiredBytes: memoryRequiredFor(model, contextLength),
    memoryAvailableBytes,
    requiresCpuOffload: false,
  }
}

export function memoryRequiredFor(model: LocalModelSpec, contextLength: number) {
  if (!Number.isSafeInteger(contextLength) || contextLength <= 0) {
    throw new Error("Context length must be a positive integer.")
  }
  return localModelWeightBytes(model) + kvCacheBytes(model.attention, contextLength) + RUNTIME_OVERHEAD_BYTES
}

export function kvCacheBytes(attention: LocalAttentionSpec, contextLength: number) {
  if (!Number.isSafeInteger(contextLength) || contextLength <= 0) {
    throw new Error("Context length must be a positive integer.")
  }
  return attention.groups.reduce((total, group) => total + groupKvBytes(group, contextLength), 0)
}

export function formatMemoryLabel(bytes: number) {
  const gib = bytes / 1024 ** 3
  if (gib >= 10) return `${Math.round(gib)} GB`
  return `${gib.toFixed(1).replace(/\.0$/, "")} GB`
}

function groupKvBytes(group: LocalKvGroup, contextLength: number) {
  const tokens = group.window === undefined ? contextLength : Math.min(contextLength, group.window)
  const bytesPerTokenPerLayer = group.bytesPerTokenPerLayer ?? group.kvHeads * group.headDim * KV_ELEMENT_BYTES
  return group.layers * bytesPerTokenPerLayer * tokens
}

function largestFittingContext(model: LocalModelSpec, memoryAvailableBytes: number) {
  let low = LOCAL_MIN_CONTEXT_LENGTH
  let high = model.nativeContextLength
  while (low < high) {
    const mid = Math.ceil((low + high + 1) / 2)
    if (memoryRequiredFor(model, mid) <= memoryAvailableBytes) low = mid
    else high = mid - 1
  }
  return low
}

function alignContext(contextLength: number, nativeContextLength: number) {
  if (contextLength >= nativeContextLength) return nativeContextLength
  return Math.floor(contextLength / LOCAL_CONTEXT_ALIGNMENT) * LOCAL_CONTEXT_ALIGNMENT
}
