import type { LocalCatalogModel } from "./types.js"

export const LOCAL_MIN_CONTEXT_LENGTH = 8_192
export const LOCAL_CONTEXT_ALIGNMENT = 1_024

/** One KV-cache population: full-context layers, or a sliding window. */
export type LocalKvGroup = {
  layers: number
  kvHeads: number
  headDim: number
  /** When set, this group only caches `window` tokens. */
  window?: number
}

export type LocalAttentionSpec = {
  groups: readonly LocalKvGroup[]
}

export type LocalModelSpec = {
  id: string
  displayName: string
  /** Official Hugging Face checkpoint this GGUF was converted from. */
  sourceModel: string
  ggufRepo: string
  ggufFile: string
  quant: string
  weightBytes: number
  nativeContextLength: number
  supportsImageInput: boolean
  attention: LocalAttentionSpec
}

/**
 * Curated local catalog. Identities are official Hugging Face checkpoints.
 * GGUF files come from the model author when they publish GGUF, otherwise from
 * ggml-org (llama.cpp) or a straight conversion of the official Instruct weights.
 *
 * Attention groups are the layers that actually allocate a token KV cache.
 * Qwen3.8 Gated DeltaNet layers keep a fixed recurrent state, not per-token KV.
 */
export const LOCAL_MODELS: readonly LocalModelSpec[] = [
  {
    id: "Qwen/Qwen3.8-27B",
    displayName: "Qwen3.8 27B",
    sourceModel: "Qwen/Qwen3.8-27B",
    ggufRepo: "ggml-org/Qwen3.8-27B-GGUF",
    ggufFile: "Qwen3.8-27B-Q4_K_M.gguf",
    quant: "Q4_K_M",
    weightBytes: 18_973_870_432,
    nativeContextLength: 262_144,
    supportsImageInput: false,
    attention: { groups: [{ layers: 16, kvHeads: 4, headDim: 256 }] },
  },
  {
    id: "Qwen/Qwen3-Coder-30B-A3B-Instruct",
    displayName: "Qwen3-Coder 30B-A3B",
    sourceModel: "Qwen/Qwen3-Coder-30B-A3B-Instruct",
    // Qwen's GGUF listing is not publicly readable; this is a Q4_K_M conversion of the official Instruct weights.
    ggufRepo: "lmstudio-community/Qwen3-Coder-30B-A3B-Instruct-GGUF",
    ggufFile: "Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf",
    quant: "Q4_K_M",
    weightBytes: 18_632_186_176,
    nativeContextLength: 262_144,
    supportsImageInput: false,
    attention: { groups: [{ layers: 48, kvHeads: 4, headDim: 128 }] },
  },
  {
    id: "openai/gpt-oss-20b",
    displayName: "gpt-oss 20B",
    sourceModel: "openai/gpt-oss-20b",
    ggufRepo: "ggml-org/gpt-oss-20b-GGUF",
    ggufFile: "gpt-oss-20b-MXFP4.gguf",
    quant: "MXFP4",
    weightBytes: 12_109_566_624,
    nativeContextLength: 131_072,
    supportsImageInput: false,
    attention: {
      groups: [
        { layers: 12, kvHeads: 8, headDim: 64 },
        { layers: 12, kvHeads: 8, headDim: 64, window: 128 },
      ],
    },
  },
  {
    id: "google/gemma-4-26B-A4B-it",
    displayName: "Gemma 4 26B A4B",
    sourceModel: "google/gemma-4-26B-A4B-it",
    ggufRepo: "google/gemma-4-26B-A4B-it-qat-q4_0-gguf",
    ggufFile: "gemma-4-26B_q4_0-it.gguf",
    quant: "Q4_0",
    weightBytes: 14_439_363_584,
    nativeContextLength: 262_144,
    supportsImageInput: false,
    attention: {
      groups: [
        { layers: 5, kvHeads: 2, headDim: 512 },
        { layers: 25, kvHeads: 8, headDim: 256, window: 1024 },
      ],
    },
  },
  {
    id: "google/gemma-4-31B-it",
    displayName: "Gemma 4 31B",
    sourceModel: "google/gemma-4-31B-it",
    ggufRepo: "google/gemma-4-31B-it-qat-q4_0-gguf",
    ggufFile: "gemma-4-31B_q4_0-it.gguf",
    quant: "Q4_0",
    weightBytes: 17_651_001_568,
    nativeContextLength: 262_144,
    supportsImageInput: false,
    attention: {
      groups: [
        { layers: 10, kvHeads: 4, headDim: 512 },
        { layers: 50, kvHeads: 16, headDim: 256, window: 1024 },
      ],
    },
  },
]

export function findLocalModel(modelId: string) {
  const id = modelId.trim()
  return LOCAL_MODELS.find((model) => model.id === id)
}

export function catalogModelFromSpec(
  spec: LocalModelSpec,
  contextLength = spec.nativeContextLength,
): LocalCatalogModel {
  return {
    provider: "local",
    id: spec.id,
    displayName: spec.displayName,
    contextLength,
    supportsImageInput: spec.supportsImageInput,
  }
}

export function isLocalModelId(modelId: string) {
  return findLocalModel(modelId) !== undefined
}
