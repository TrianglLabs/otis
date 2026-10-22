import { describe, expect, it } from "vitest"
import {
  fireworksServiceTier,
  isFastFireworksModel,
  selectDefaultFireworksModel,
} from "../../src/inference/serving-path.js"
import type { HostedModel } from "../../src/inference/types.js"

describe("Fireworks serving paths", () => {
  it("recognizes Fast router IDs", () => {
    expect(isFastFireworksModel("accounts/fireworks/routers/kimi-k3-fast")).toBe(true)
    expect(isFastFireworksModel("accounts/fireworks/models/kimi-k3")).toBe(false)
    expect(isFastFireworksModel("accounts/fireworks/routers/kimi-k3-us")).toBe(false)
  })

  it("omits Priority on Fast requests and keeps it for base models", () => {
    expect(fireworksServiceTier("accounts/fireworks/routers/kimi-k3-fast")).toBeUndefined()
    expect(fireworksServiceTier("accounts/fireworks/models/kimi-k3")).toBe("priority")
  })
})

describe("Fireworks default model policy", () => {
  const muse = model("accounts/fireworks/models/muse-glimmer-30b", "Muse Glimmer")
  const inkling = model("accounts/fireworks/models/inkling", "Inkling")

  it("prefers Muse Glimmer regardless of catalog order", () => {
    expect(selectDefaultFireworksModel([model("fallback", "Fallback"), inkling, muse])).toBe(muse)
  })

  it("falls back to Inkling when Muse Glimmer is unavailable", () => {
    expect(selectDefaultFireworksModel([model("fallback", "Fallback"), inkling])).toBe(inkling)
  })

  it("uses the first verified catalog model when neither preferred model is available", () => {
    const first = model("first", "First")
    expect(selectDefaultFireworksModel([first, model("second", "Second")])).toBe(first)
  })

  it("returns undefined for an empty catalog", () => {
    expect(selectDefaultFireworksModel([])).toBeUndefined()
  })

  it("skips Fast serving-path entries when choosing a fallback default", () => {
    const fast = model("accounts/fireworks/routers/kimi-k3-fast", "Kimi K3 Fast")
    const standard = model("accounts/fireworks/models/kimi-k3", "Kimi K3")
    expect(selectDefaultFireworksModel([fast, standard])).toBe(standard)
  })
})

function model(id: string, displayName: string): HostedModel {
  return {
    provider: "fireworks",
    id,
    displayName,
    supportsImageInput: true,
    contextLength: 128_000,
  }
}
