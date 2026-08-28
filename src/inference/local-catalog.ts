import type { LocalCatalogModel } from "./types.js"

export const LOCAL_MIN_CONTEXT_LENGTH = 8_192
export const LOCAL_CONTEXT_ALIGNMENT = 1_024

type StandardKvGeometry = {
  /** Standard separate f16 key/value cache geometry. */
  bytesPerTokenPerLayer?: never
  headDim: number
  kvHeads: number
}

type CompressedKvGeometry = {
  /** Direct cache size for architectures such as MLA that store compressed latent KV. */
  bytesPerTokenPerLayer: number
  headDim?: never
  kvHeads?: never
}

/** One KV-cache population: full-context layers, or a sliding window. */
export type LocalKvGroup = (StandardKvGeometry | CompressedKvGeometry) & {
  layers: number
  /** When set, this group only caches `window` tokens. */
  window?: number
}

export type LocalAttentionSpec = {
  groups: readonly LocalKvGroup[]
}

export type LocalGgufFile = {
  name: string
  /** SHA-256 from the repository's Git LFS object metadata. */
  sha256: string
  size: number
}

export type LocalModelSpec = {
  id: string
  displayName: string
  /** Official Hugging Face checkpoint this GGUF was converted from. */
  sourceModel: string
  ggufRepo: string
  /** Immutable Hugging Face repository commit containing every `ggufFiles` entry. */
  ggufRevision: string
  /** One file for a normal GGUF, or all files for a split GGUF in load order. */
  ggufFiles: readonly [LocalGgufFile, ...LocalGgufFile[]]
  quant: string
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
 * Hybrid recurrent and convolution layers keep fixed state, not per-token KV.
 */
export const LOCAL_MODELS: readonly LocalModelSpec[] = [
  {
    id: "ornith-ai/Ornith-1.5-9B",
    displayName: "Ornith 1.5 9B",
    sourceModel: "ornith-ai/Ornith-1.5-9B",
    ggufRepo: "ornith-ai/Ornith-1.5-9B-GGUF",
    ggufRevision: "abdd624b12ebf020b767fff532ff44fe552b28c3",
    ggufFiles: [
      {
        name: "Ornith-1.5-9B-Q4_K_M.gguf",
        sha256: "70c112196e0b7023803c9762752e46d29e612a92c83f995bc3ba1ceb07e8fab6",
        size: 5_780_090_816,
      },
    ],
    quant: "Q4_K_M",
    nativeContextLength: 262_144,
    // The checkpoint is multimodal, but local image input also requires the separate mmproj artifact.
    supportsImageInput: false,
    attention: { groups: [{ layers: 8, kvHeads: 4, headDim: 256 }] },
  },
  {
    id: "google/gemma-4-12B-it",
    displayName: "Gemma 4 12B",
    sourceModel: "google/gemma-4-12B-it",
    ggufRepo: "google/gemma-4-12B-it-qat-q4_0-gguf",
    ggufRevision: "29d097773436b69ff9feafd636ab4cf873786537",
    ggufFiles: [
      {
        name: "gemma-4-12b-it-qat-q4_0.gguf",
        sha256: "93567e57a8fe10b23569b9d9ec38cd005deedf71e29477c421a4b83f418a538b",
        size: 6_975_879_296,
      },
    ],
    quant: "Q4_0",
    nativeContextLength: 262_144,
    // The checkpoint is multimodal, but local image input also requires the separate mmproj artifact.
    supportsImageInput: false,
    attention: {
      groups: [
        { layers: 8, kvHeads: 1, headDim: 512 },
        { layers: 40, kvHeads: 8, headDim: 256, window: 1024 },
      ],
    },
  },
  {
    id: "LiquidAI/LFM2.5-2.6B",
    displayName: "LFM2.5 2.6B",
    sourceModel: "LiquidAI/LFM2.5-2.6B",
    ggufRepo: "LiquidAI/LFM2.5-2.6B-GGUF",
    ggufRevision: "84022ce711b28455e8c4fc364ce68c00cf995875",
    ggufFiles: [
      {
        name: "LFM2.5-2.6B-Q4_K_M.gguf",
        sha256: "02a8b7e17487d326e46d68ce0ba24211e1b80a14c4cd0597fa73c1cd697f52ed",
        size: 1_674_455_040,
      },
    ],
    quant: "Q4_K_M",
    nativeContextLength: 131_072,
    supportsImageInput: false,
    attention: { groups: [{ layers: 8, kvHeads: 8, headDim: 64 }] },
  },
  {
    id: "Qwen/Qwen3.8-27B",
    displayName: "Qwen3.8 27B",
    sourceModel: "Qwen/Qwen3.8-27B",
    ggufRepo: "ggml-org/Qwen3.8-27B-GGUF",
    ggufRevision: "0669b98607d47046c7c2b3f801011d54a08cfccf",
    ggufFiles: [
      {
        name: "Qwen3.8-27B-Q4_K_M.gguf",
        sha256: "31629f53165ab6a7dad8c9847dcfd1fdf55829dac1e6e748f4a68581b0033d34",
        size: 18_973_870_432,
      },
    ],
    quant: "Q4_K_M",
    nativeContextLength: 262_144,
    supportsImageInput: false,
    attention: { groups: [{ layers: 16, kvHeads: 4, headDim: 256 }] },
  },
  {
    id: "Qwen/Qwen3.8-Flash-Next",
    displayName: "Qwen3.8 Flash Next",
    sourceModel: "Qwen/Qwen3.8-Flash-Next",
    // Qwen's ggml-org conversion is Q8 only; this smaller conversion is from the official checkpoint.
    ggufRepo: "unsloth/Qwen3.8-Flash-Next-GGUF",
    ggufRevision: "c8b5954a88c2775c546b92593eda40ea041d3176",
    ggufFiles: [
      {
        name: "UD-IQ3_XXS/Qwen3.8-Flash-Next-UD-IQ3_XXS-00001-of-00003.gguf",
        sha256: "268f81fdedf3149a538f252308927a4d5d1f6e062c178568a51e3b519744f8a8",
        size: 10_946_624,
      },
      {
        name: "UD-IQ3_XXS/Qwen3.8-Flash-Next-UD-IQ3_XXS-00002-of-00003.gguf",
        sha256: "cfe600b236b88c7fad1613a5ca5e83b9f2beb63cbd44c32b2be50a44747c695f",
        size: 49_567_921_344,
      },
      {
        name: "UD-IQ3_XXS/Qwen3.8-Flash-Next-UD-IQ3_XXS-00003-of-00003.gguf",
        sha256: "f1912ba34c79427d2295a58dcb2b732b5931af5bef7a373c60557a57d9ee7250",
        size: 32_382_955_968,
      },
    ],
    quant: "UD-IQ3_XXS",
    nativeContextLength: 262_144,
    // The checkpoint is multimodal, but local image input also requires the separate mmproj artifact.
    supportsImageInput: false,
    attention: { groups: [{ layers: 12, kvHeads: 2, headDim: 256 }] },
  },
  {
    id: "Qwen/Qwen3-Coder-30B-A3B-Instruct",
    displayName: "Qwen3-Coder 30B-A3B",
    sourceModel: "Qwen/Qwen3-Coder-30B-A3B-Instruct",
    // Qwen's GGUF listing is not publicly readable; this is a Q4_K_M conversion of the official Instruct weights.
    ggufRepo: "lmstudio-community/Qwen3-Coder-30B-A3B-Instruct-GGUF",
    ggufRevision: "1f4ceb1041258b3fbfe59e1175d1321c6b41863b",
    ggufFiles: [
      {
        name: "Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf",
        sha256: "79ad15a5ee3caddc3f4ff0db33a14454a5a3eb503d7fa1c1e35feafc579de486",
        size: 18_632_186_176,
      },
    ],
    quant: "Q4_K_M",
    nativeContextLength: 262_144,
    supportsImageInput: false,
    attention: { groups: [{ layers: 48, kvHeads: 4, headDim: 128 }] },
  },
  {
    id: "openai/gpt-oss-20b",
    displayName: "gpt-oss 20B",
    sourceModel: "openai/gpt-oss-20b",
    ggufRepo: "ggml-org/gpt-oss-20b-GGUF",
    ggufRevision: "ef9b12f2ff56c69cf32153a02784e7a3c88bf524",
    ggufFiles: [
      {
        name: "gpt-oss-20b-MXFP4.gguf",
        sha256: "27cd6c432c7672cb812a92f611cf3ba7bbc35928262bb1e1253ff4ee6ae35901",
        size: 12_109_566_624,
      },
    ],
    quant: "MXFP4",
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
    ggufRevision: "d1c082be9cf3c8a514acf63b8761f4b41935842e",
    ggufFiles: [
      {
        name: "gemma-4-26B_q4_0-it.gguf",
        sha256: "3eca3b8f6d7baf218a7dd6bba5fb59a56ee25fe2d567b6f5f589b4f697eca51d",
        size: 14_439_363_584,
      },
    ],
    quant: "Q4_0",
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
    ggufRevision: "59dde24573e7e61570dba08b18a2e1fe246955ed",
    ggufFiles: [
      {
        name: "gemma-4-31B_q4_0-it.gguf",
        sha256: "179cfb99212709597eae5929112cfca677e1bbf566178b479ae1da0c4772874b",
        size: 17_651_001_568,
      },
    ],
    quant: "Q4_0",
    nativeContextLength: 262_144,
    supportsImageInput: false,
    attention: {
      groups: [
        { layers: 10, kvHeads: 4, headDim: 512 },
        { layers: 50, kvHeads: 16, headDim: 256, window: 1024 },
      ],
    },
  },
  {
    id: "zai-org/GLM-5.3",
    displayName: "GLM-5.3",
    sourceModel: "zai-org/GLM-5.3",
    ggufRepo: "unsloth/GLM-5.3-GGUF",
    ggufRevision: "8cf52b13b13065f576d01753f5f65f7263cc9062",
    ggufFiles: [
      {
        name: "UD-Q3_K_XL/GLM-5.3-UD-Q3_K_XL-00001-of-00009.gguf",
        sha256: "e902b340f072aa2d7244a10b9465f0e6d08caad2fa0f4f050b4f1a6c7c36ee1b",
        size: 9_428_640,
      },
      {
        name: "UD-Q3_K_XL/GLM-5.3-UD-Q3_K_XL-00002-of-00009.gguf",
        sha256: "4a66db8d7f441a948d435e7559a4080a58cc57a8cb35ce9104103ea4039cf34f",
        size: 48_804_973_120,
      },
      {
        name: "UD-Q3_K_XL/GLM-5.3-UD-Q3_K_XL-00003-of-00009.gguf",
        sha256: "03c626e0fe1cb5e9f245afa092df6c25fa1f55b1072ec65f143f804cec04b710",
        size: 48_508_432_544,
      },
      {
        name: "UD-Q3_K_XL/GLM-5.3-UD-Q3_K_XL-00004-of-00009.gguf",
        sha256: "d391c041f80c0fdf6cf92777528f642a1e6882562e5f0727cf35e00be7c8f686",
        size: 48_508_432_544,
      },
      {
        name: "UD-Q3_K_XL/GLM-5.3-UD-Q3_K_XL-00005-of-00009.gguf",
        sha256: "34f022b34bc4be26bec87e3ffb7b832a4a357f550c748c9a0013afbf0ce01918",
        size: 48_508_432_544,
      },
      {
        name: "UD-Q3_K_XL/GLM-5.3-UD-Q3_K_XL-00006-of-00009.gguf",
        sha256: "6961dbf52a18a6806ac3e399617fb3a6faeaca8d7264241f38cf972ef94bb5b7",
        size: 48_508_432_544,
      },
      {
        name: "UD-Q3_K_XL/GLM-5.3-UD-Q3_K_XL-00007-of-00009.gguf",
        sha256: "0b70151675f930eed91c83e51aa8c977657c4fe371af1a02951dd1b4e7258a68",
        size: 48_508_432_544,
      },
      {
        name: "UD-Q3_K_XL/GLM-5.3-UD-Q3_K_XL-00008-of-00009.gguf",
        sha256: "04eaa6d2cb5a548854c719994816a791a4e3d7783f38979e95b389f8f840badf",
        size: 48_717_290_336,
      },
      {
        name: "UD-Q3_K_XL/GLM-5.3-UD-Q3_K_XL-00009-of-00009.gguf",
        sha256: "6227252600ff83f185b6ad149266fbd0cb1c1f57ae0bfb71c247ee49faa3c31b",
        size: 2_892_122_176,
      },
    ],
    quant: "UD-Q3_K_XL",
    nativeContextLength: 1_048_576,
    supportsImageInput: false,
    // GLM's MLA cache stores a 512-wide latent plus 64 rotary dimensions per layer.
    attention: { groups: [{ layers: 78, bytesPerTokenPerLayer: (512 + 64) * 2 }] },
  },
]

export function localModelWeightBytes(model: LocalModelSpec) {
  return model.ggufFiles.reduce((total, file) => total + file.size, 0)
}

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
