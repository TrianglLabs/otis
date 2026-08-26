import { describe, expect, it } from "vitest"
import {
  baseModelIdForFastServingPath,
  fireworksServiceTier,
  fireworksServingModel,
  isFastFireworksModel,
  matchesFireworksModel,
  useFastServingPath,
  withFastServingPaths,
} from "../../src/inference/serving-path.js"
import type { FireworksModel } from "../../src/inference/types.js"

describe("Fireworks serving paths", () => {
  it("recognizes Fast router IDs", () => {
    expect(isFastFireworksModel("accounts/fireworks/routers/kimi-k3-fast")).toBe(true)
    expect(isFastFireworksModel("accounts/fireworks/models/kimi-k3")).toBe(false)
    expect(isFastFireworksModel("accounts/fireworks/routers/kimi-k3-us")).toBe(false)
  })

  it("maps Fast router IDs back to the matching base model", () => {
    expect(baseModelIdForFastServingPath("accounts/fireworks/routers/kimi-k3-fast")).toBe(
      "accounts/fireworks/models/kimi-k3",
    )
    expect(baseModelIdForFastServingPath("accounts/fireworks/routers/kimi-k2p7-code-fast")).toBe(
      "accounts/fireworks/models/kimi-k2p7-code",
    )
    expect(baseModelIdForFastServingPath("accounts/fireworks/models/kimi-k3")).toBeUndefined()
  })

  it("omits Priority on Fast requests and keeps it for base models", () => {
    expect(fireworksServiceTier("accounts/fireworks/routers/kimi-k3-fast")).toBeUndefined()
    expect(fireworksServiceTier("accounts/fireworks/models/kimi-k3")).toBe("priority")
  })

  it("annotates matching catalog models with their Fast serving path", () => {
    const kimi = model("accounts/fireworks/models/kimi-k3", "Kimi K3")
    const glm = model("accounts/fireworks/models/glm-5p2", "GLM 5.2")

    expect(
      withFastServingPaths(
        [kimi, glm],
        [
          "accounts/fireworks/routers/kimi-k3-fast",
          "accounts/fireworks/routers/kimi-k2p6-turbo",
          "accounts/fireworks/routers/orphan-fast",
          "accounts/fireworks/models/kimi-k3",
        ],
      ),
    ).toEqual([{ ...kimi, fastId: "accounts/fireworks/routers/kimi-k3-fast" }, glm])
  })

  it("keeps Fast serving opt-in unless the model ID is already a Fast router", () => {
    expect(useFastServingPath("accounts/fireworks/models/kimi-k3")).toBe(false)
    expect(useFastServingPath("accounts/fireworks/models/kimi-k3", false)).toBe(false)
    expect(useFastServingPath("accounts/fireworks/models/kimi-k3", true)).toBe(true)
    expect(useFastServingPath("accounts/fireworks/routers/kimi-k3-fast")).toBe(true)
    expect(useFastServingPath("accounts/fireworks/routers/kimi-k3-fast", false)).toBe(true)
    expect(useFastServingPath(undefined, true)).toBe(true)
    expect(useFastServingPath(undefined)).toBe(false)
  })

  it("toggles a model between catalog and Fast serving IDs", () => {
    const kimi = model("accounts/fireworks/models/kimi-k3", "Kimi K3")
    const fast = { ...kimi, fastId: "accounts/fireworks/routers/kimi-k3-fast" }
    expect(fireworksServingModel(fast, true)).toEqual({ ...fast, id: fast.fastId })
    expect(fireworksServingModel(fast, false)).toEqual(fast)
    expect(fireworksServingModel({ ...fast, id: fast.fastId }, false)).toEqual(fast)
    expect(fireworksServingModel(kimi, true)).toBe(kimi)
    expect(matchesFireworksModel(fast, kimi.id)).toBe(true)
    expect(matchesFireworksModel(fast, fast.fastId ?? "")).toBe(true)
  })
})

function model(id: string, displayName: string): FireworksModel {
  return { provider: "fireworks", id, displayName, supportsImageInput: true, contextLength: 128_000 }
}
