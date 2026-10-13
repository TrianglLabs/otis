import { describe, expect, it } from "vitest"
import {
  findLocalModel,
  LOCAL_MODELS,
  localFileSource,
  localModelFiles,
  localModelPackings,
  localModelWeightBytes,
} from "../../src/inference/local-catalog.js"
import { LOCAL_MODEL_CARDS, localModelCard } from "../../src/inference/model-cards.js"

describe("local model catalog", () => {
  it("carries a sourced card for every catalog model and for nothing else", () => {
    for (const model of LOCAL_MODELS) {
      const card = localModelCard(model.id)
      expect(card, model.id).toBeDefined()
      expect(card?.bestAt.length).toBeGreaterThan(0)
      expect(card?.worstAt.length).toBeGreaterThan(0)
      expect(card?.source).toBe(`https://huggingface.co/${model.sourceModel}`)
    }
    expect(Object.keys(LOCAL_MODEL_CARDS).sort()).toEqual(
      LOCAL_MODELS.map((model) => model.id).sort(),
    )
    expect(localModelCard("Qwen/Qwen3-Coder-30B-A3B-Instruct")).toBeUndefined()
  })

  it("does not offer Qwen Coder as a managed local model", () => {
    expect(findLocalModel("Qwen/Qwen3-Coder-30B-A3B-Instruct")).toBeUndefined()
  })

  it("pins the model-author GGUF for Ornith 1.5 9B", () => {
    expect(findLocalModel("ornith-ai/Ornith-1.5-9B")).toMatchObject({
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
      mmproj: {
        name: "mmproj-Ornith-1.5-9B-BF16.gguf",
        sha256: "626f9f90627402a6bf4a999111d0fbd69b5fcca7aa8ba089d69e5f10e8858e1d",
        size: 921_704_672,
      },
      nativeContextLength: 262_144,
      supportsImageInput: true,
    })
  })

  it("offers image input exactly for the models whose vision projector is pinned", () => {
    for (const model of LOCAL_MODELS) {
      for (const packing of localModelPackings(model)) {
        expect(packing.supportsImageInput).toBe(packing.mmproj !== undefined)
        expect(localModelFiles(packing).at(-1)).toBe(packing.mmproj ?? packing.ggufFiles.at(-1))
        // The projector loads into memory beside the weights, so it counts in the footprint.
        expect(localModelWeightBytes(packing)).toBe(
          packing.ggufFiles.reduce((sum, file) => sum + file.size, packing.mmproj?.size ?? 0),
        )
      }
    }
    expect(
      LOCAL_MODELS.filter((model) => model.supportsImageInput).map((model) => model.id),
    ).toEqual([
      "ornith-ai/Ornith-1.5-9B",
      "google/gemma-4-12B-it",
      "Qwen/Qwen3.8-27B",
      "prism-ml/Ternary-Bonsai-2-27B-gguf",
      "ConwayResearch/Underdog-Saluki-27B-1.0",
      "Qwen/Qwen3.8-Flash-Next",
      "google/gemma-4-26B-A4B-it",
      "google/gemma-4-31B-it",
    ])
  })

  it("pins the current model-author GGUF for Liquid AI's 2.6B model", () => {
    expect(findLocalModel("LiquidAI/LFM2.5-2.6B")).toMatchObject({
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
      nativeContextLength: 131_072,
      supportsImageInput: false,
    })
  })

  it("pins Liquid AI's QAD Q4_0 GGUF for the 24B A2B mixture of experts", () => {
    expect(findLocalModel("LiquidAI/LFM2.5-24B-A2B")).toMatchObject({
      sourceModel: "LiquidAI/LFM2.5-24B-A2B",
      runtime: "upstream",
      ggufRepo: "LiquidAI/LFM2.5-24B-A2B-GGUF",
      ggufRevision: "0912d33141f77e10705345a6732bfd83f0252fdc",
      ggufFiles: [
        {
          name: "LFM2.5-24B-A2B-QAD-Q4_0.gguf",
          sha256: "d1c03f73ecaf61017d70419eec9e5dc0b05d50ae26c23d522829b934fbabf8a5",
          size: 13_578_190_880,
        },
      ],
      quant: "Q4_0",
      nativeContextLength: 131_072,
      supportsImageInput: false,
      // Only the ten full-attention layers of the hybrid stack hold a token KV cache.
      attention: { groups: [{ layers: 10, kvHeads: 8, headDim: 64 }] },
    })
  })

  it("pins Underdog's Saluki GGUF and its Q8 vision projector on the upstream runtime", () => {
    expect(findLocalModel("ConwayResearch/Underdog-Saluki-27B-1.0")).toMatchObject({
      displayName: "Underdog Saluki 27B",
      sourceModel: "ConwayResearch/Underdog-Saluki-27B-1.0",
      runtime: "upstream",
      ggufRepo: "ConwayResearch/Underdog-Saluki-27B-1.0",
      ggufRevision: "4f60eba09f4b6db63c72915d328d97e1d93edb8c",
      ggufFiles: [
        {
          name: "Underdog-Saluki-27B-1.0-IQ2-mix.gguf",
          sha256: "4a673518b11b1c4445f9b9a9d3c40356f5ba39f6a6260dcb25f3fbfd475d9efb",
          size: 7_898_369_152,
        },
      ],
      mmproj: {
        name: "mmproj-Underdog-Saluki-27B-1.0-Q8_0.gguf",
        sha256: "2e0b88b680a45a58eea666b9776a89601b16f4ef575b871a686d82ee65938756",
        size: 629_246_976,
      },
      quant: "IQ2-mix",
      nativeContextLength: 262_144,
      supportsImageInput: true,
      // Saluki keeps the Qwen3.8 27B KV-cache geometry.
      attention: { groups: [{ layers: 16, kvHeads: 4, headDim: 256 }] },
    })
  })

  it("pins Google's official QAT GGUF for Gemma 4 12B IT", () => {
    expect(findLocalModel("google/gemma-4-12B-it")).toMatchObject({
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
      mmproj: {
        name: "mmproj-gemma-4-12b-it-qat-q4_0.gguf",
        sha256: "cb018338a7538a9814d994bfe54644c71eb7ed54e31eae2f721e45fd3c260da7",
        size: 175_115_616,
      },
      quant: "Q4_0",
      nativeContextLength: 262_144,
      supportsImageInput: true,
    })
  })

  it("pins both Bonsai packings and the required Prism runtime", () => {
    expect(findLocalModel("prism-ml/Ternary-Bonsai-2-27B-gguf")).toMatchObject({
      displayName: "Bonsai 2 27B",
      sourceModel: "prism-ml/Ternary-Bonsai-2-27B-gguf",
      runtime: "prism",
      ggufRepo: "prism-ml/Ternary-Bonsai-2-27B-gguf",
      ggufRevision: "6ed5e12bf84b7a63069882c91dd9e9218647d17b",
      ggufFiles: [
        {
          name: "Ternary-Bonsai-2-27B-PQ2_0.gguf",
          sha256: "3907dc1658db1f78a9826bf8d5bcb8dc65db0d466388937af57f2294fae62ec1",
          size: 7_206_168_928,
        },
      ],
      mmproj: {
        name: "Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf",
        sha256: "6807ede61d570bb86ba34b756a0fa109edc33668604de867c6ea6d8f1d631903",
        size: 629_246_976,
      },
      quant: "PQ2_0",
      packings: [
        {
          ggufFiles: [
            {
              name: "Ternary-Bonsai-2-27B-PTQ1_0.gguf",
              sha256: "53107f530aa52eb00912263ab1ee29bd199261c87cd7b4ad4ca1318c1fe33ee3",
              size: 5_946_648_928,
            },
          ],
          quant: "PTQ1_0",
        },
        {
          ggufFiles: [
            {
              name: "Ternary-Bonsai-2-27B-PQ2_0.gguf",
              sha256: "3907dc1658db1f78a9826bf8d5bcb8dc65db0d466388937af57f2294fae62ec1",
              size: 7_206_168_928,
            },
          ],
          quant: "PQ2_0",
        },
      ],
      nativeContextLength: 262_144,
      supportsImageInput: true,
      attention: { groups: [{ layers: 16, kvHeads: 4, headDim: 256 }] },
    })
  })

  it("pins both Qwen3.8 Flash Next packings, Qwen's own Q8 from its separate repository", () => {
    const model = findLocalModel("Qwen/Qwen3.8-Flash-Next")
    if (!model?.mmproj) throw new Error("missing catalog entry")
    expect(model).toMatchObject({
      sourceModel: "Qwen/Qwen3.8-Flash-Next",
      ggufRepo: "unsloth/Qwen3.8-Flash-Next-GGUF",
      ggufRevision: "c8b5954a88c2775c546b92593eda40ea041d3176",
      quant: "UD-IQ3_XXS",
      nativeContextLength: 262_144,
      supportsImageInput: true,
    })
    expect(model.ggufFiles).toHaveLength(3)
    expect(localModelWeightBytes(model)).toBe(81_961_823_936 + 616_703_104)
    const [compact, official] = localModelPackings(model)
    expect(compact).toMatchObject({
      quant: "UD-IQ3_XXS",
      ggufRepo: "unsloth/Qwen3.8-Flash-Next-GGUF",
    })
    expect(official).toMatchObject({
      quant: "Q8_0",
      ggufRepo: "ggml-org/Qwen3.8-Flash-Next-GGUF",
      ggufRevision: "01534bc2e1877d5de995b73d247d4459d273e688",
    })
    expect(official?.ggufFiles).toHaveLength(2)
    expect(official && localModelWeightBytes(official)).toBe(162_624_826_656 + 616_703_104)
    // Both packings load Qwen's Q8 projector, which the IQ3 packing fetches from Qwen's repository
    // rather than from its own weights' repository.
    for (const packing of [compact, official]) {
      expect(packing?.mmproj).toBe(model.mmproj)
      expect(packing && localFileSource(packing, model.mmproj)).toEqual({
        repo: "ggml-org/Qwen3.8-Flash-Next-GGUF",
        revision: "01534bc2e1877d5de995b73d247d4459d273e688",
      })
    }
    expect(localFileSource(compact, compact.ggufFiles[0])).toEqual({
      repo: "unsloth/Qwen3.8-Flash-Next-GGUF",
      revision: "c8b5954a88c2775c546b92593eda40ea041d3176",
    })
  })

  it("pins a split GLM-5.3 conversion of the official checkpoint", () => {
    const model = findLocalModel("zai-org/GLM-5.3")
    expect(model).toMatchObject({
      sourceModel: "zai-org/GLM-5.3",
      ggufRepo: "unsloth/GLM-5.3-GGUF",
      ggufRevision: "8cf52b13b13065f576d01753f5f65f7263cc9062",
      quant: "UD-Q3_K_XL",
      nativeContextLength: 1_048_576,
      supportsImageInput: false,
    })
    expect(model?.ggufFiles).toHaveLength(9)
    expect(model && localModelWeightBytes(model)).toBe(342_965_976_992)
  })
})
