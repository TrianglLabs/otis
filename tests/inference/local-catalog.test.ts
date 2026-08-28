import { describe, expect, it } from "vitest"
import { findLocalModel, localModelWeightBytes } from "../../src/inference/local-catalog.js"

describe("local model catalog", () => {
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
      nativeContextLength: 262_144,
      supportsImageInput: false,
    })
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
      quant: "Q4_0",
      nativeContextLength: 262_144,
      supportsImageInput: false,
    })
  })

  it("pins a split Qwen3.8 Flash Next conversion of the official checkpoint", () => {
    const model = findLocalModel("Qwen/Qwen3.8-Flash-Next")
    expect(model).toMatchObject({
      sourceModel: "Qwen/Qwen3.8-Flash-Next",
      ggufRepo: "unsloth/Qwen3.8-Flash-Next-GGUF",
      ggufRevision: "c8b5954a88c2775c546b92593eda40ea041d3176",
      quant: "UD-IQ3_XXS",
      nativeContextLength: 262_144,
      supportsImageInput: false,
    })
    expect(model?.ggufFiles).toHaveLength(3)
    expect(model && localModelWeightBytes(model)).toBe(81_961_823_936)
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
