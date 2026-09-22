import { LOCAL_MIN_CONTEXT_LENGTH } from "./context-policy.js"
import { availableModelMemory, type HardwareProbe, inferenceMemoryBudget } from "./hardware.js"
import {
  type LocalAttentionSpec,
  type LocalModelSpec,
  localModelForHardware,
  localModelWeightBytes,
} from "./local-catalog.js"

// llama.cpp reserves its compute buffers for one micro-batch (n_ubatch, default 512) in which
// every token produces logits (llama-context.cpp, "reserve worst-case graph"), so the buffers
// hold an f32 [n_vocab, 512] logits slice, an f16 [n_ctx, 512] flash-attention mask that is
// built on the host and copied to the device, and one micro-batch of layer activations. A
// fixed floor covers the process itself. The pinned runtime reports 409 MiB device plus 136 MiB
// host compute buffers for LFM2.5 2.6B at 128K against 538 MiB modeled here (see
// tests/inference/local-fit.test.ts); llama.cpp remains authoritative at load.
const MICRO_BATCH_TOKENS = 512
const RUNTIME_FLOOR_BYTES = 512 * 1024 ** 2
/** Peak live activations of a micro-batch: two FFN intermediates of about four times the width. */
const ACTIVATION_WIDTHS = 8
const KV_ELEMENT_BYTES = 4 // f16 key + f16 value
/** A sliding-window cache holds the window plus one micro-batch, in 256-cell steps. */
const KV_CELL_ALIGNMENT = 256
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
  const logits = model.vocabSize * MICRO_BATCH_TOKENS * 4
  const masks = 2 * contextLength * MICRO_BATCH_TOKENS * 2
  const activations = ACTIVATION_WIDTHS * model.hiddenSize * MICRO_BATCH_TOKENS * 4
  return (
    localModelWeightBytes(model) +
    kvCacheBytes(model.attention, contextLength) +
    RUNTIME_FLOOR_BYTES +
    logits +
    masks +
    activations
  )
}

/** llama-kv-cache-iswa.cpp: `GGML_PAD(min(n_ctx, n_swa * n_seq_max + n_ubatch), 256)` cells. */
function kvCacheBytes(attention: LocalAttentionSpec, contextLength: number) {
  return attention.groups.reduce((total, group) => {
    const cells =
      group.window === undefined
        ? contextLength
        : Math.min(
            contextLength,
            Math.ceil((group.window + MICRO_BATCH_TOKENS) / KV_CELL_ALIGNMENT) * KV_CELL_ALIGNMENT,
          )
    const bytesPerTokenPerLayer =
      group.bytesPerTokenPerLayer ?? group.kvHeads * group.headDim * KV_ELEMENT_BYTES
    return total + group.layers * bytesPerTokenPerLayer * cells
  }, 0)
}

export function formatMemoryLabel(bytes: number) {
  const gib = bytes / 1024 ** 3
  return `${gib >= 10 ? Math.round(gib) : gib.toFixed(1).replace(/\.0$/, "")} GB`
}
