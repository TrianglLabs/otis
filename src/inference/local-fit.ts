import { availableInferenceMemory, type HardwareProbe } from "./hardware.js"
import {
  LOCAL_CONTEXT_ALIGNMENT,
  LOCAL_MIN_CONTEXT_LENGTH,
  type LocalAttentionSpec,
  type LocalKvGroup,
  type LocalModelSpec,
} from "./local-catalog.js"

const GRAPH_OVERHEAD_BYTES = 512 * 1024 * 1024
const KV_ELEMENT_BYTES = 4 // f16 key + f16 value

export type LocalModelFit = {
  model: LocalModelSpec
  available: boolean
  contextLength: number
  memoryRequiredBytes: number
  memoryAvailableBytes: number
}

export function fitLocalModel(model: LocalModelSpec, hardware: HardwareProbe): LocalModelFit {
  const memoryAvailableBytes = availableInferenceMemory(hardware)
  return fitLocalModelWithinMemory(model, memoryAvailableBytes)
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
    }
  }

  return {
    model,
    available: true,
    contextLength,
    memoryRequiredBytes: memoryRequiredFor(model, contextLength),
    memoryAvailableBytes,
  }
}

export function memoryRequiredFor(model: LocalModelSpec, contextLength: number) {
  if (!Number.isSafeInteger(contextLength) || contextLength <= 0) {
    throw new Error("Context length must be a positive integer.")
  }
  return model.weightBytes + kvCacheBytes(model.attention, contextLength) + GRAPH_OVERHEAD_BYTES
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
  return group.layers * group.kvHeads * group.headDim * KV_ELEMENT_BYTES * tokens
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
