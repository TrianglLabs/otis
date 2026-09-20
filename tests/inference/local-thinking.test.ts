import { describe, expect, it } from "vitest"
import {
  localThinkingCapability,
  localThinkingParameters,
  validateLocalThinkingSelection,
} from "../../src/inference/local-thinking.js"

describe("local thinking capabilities", () => {
  it("offers only native effort tiers and excludes unsupported Bonsai low effort", () => {
    expect(localThinkingCapability("Qwen/Qwen3.8-27B")?.levels).toEqual(["off", "low", "medium", "xhigh"])
    expect(localThinkingCapability("prism-ml/Ternary-Bonsai-2-27B-gguf")?.levels).toEqual(["off", "medium", "xhigh"])
    expect(() => validateLocalThinkingSelection("prism-ml/Ternary-Bonsai-2-27B-gguf", "low")).toThrow()
    expect(() => validateLocalThinkingSelection("Qwen/Qwen3.8-27B", "high")).toThrow()
    expect(localThinkingCapability("LiquidAI/LFM2.5-2.6B")).toBeUndefined()
    expect(localThinkingCapability("toString")).toBeUndefined()
  })

  it("uses enable_thinking for switches and leaves defaults unmodified", () => {
    expect(localThinkingParameters("google/gemma-4-12B-it", "on")).toEqual({
      chat_template_kwargs: { enable_thinking: true },
    })
    expect(localThinkingParameters("Qwen/Qwen3.8-27B", "off")).toEqual({
      chat_template_kwargs: { enable_thinking: false },
    })
    expect(localThinkingParameters("openai/gpt-oss-20b", "low")).toEqual({ reasoning_effort: "low" })
    expect(localThinkingParameters("zai-org/GLM-5.3", "max")).toEqual({ reasoning_effort: "max" })
    expect(localThinkingParameters("Qwen/Qwen3.8-27B", undefined)).toEqual({})
    expect(localThinkingParameters("unknown", "high")).toEqual({})
  })
})
