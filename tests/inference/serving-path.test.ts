import { describe, expect, it } from "vitest"
import { fireworksServiceTier, isFastFireworksModel } from "../../src/inference/serving-path.js"

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
