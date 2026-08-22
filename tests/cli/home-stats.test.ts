import { describe, expect, it } from "vitest"
import { easeOutCubic, interpolateStats, ZERO_STATS } from "../../src/cli/ui/home-stats.js"

describe("home stats motion", () => {
  const target = {
    streak: 7,
    totalTokens: 1_250_000,
    sessionCount: 12,
    avgTokensPerSession: 24_600,
    avgSessionSeconds: 420,
  }

  it("returns the start and end stats at the extremes", () => {
    expect(interpolateStats(ZERO_STATS, target, 0)).toEqual(ZERO_STATS)
    expect(interpolateStats(ZERO_STATS, target, 1)).toEqual(target)
  })

  it("eases out so early frames move faster than the last ones", () => {
    expect(easeOutCubic(0)).toBe(0)
    expect(easeOutCubic(1)).toBe(1)
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.8)
  })

  it("keeps mid-animation values between the endpoints", () => {
    const mid = interpolateStats(ZERO_STATS, target, 0.4)
    expect(mid.streak).toBeGreaterThan(0)
    expect(mid.streak).toBeLessThan(target.streak)
    expect(mid.totalTokens).toBeGreaterThan(0)
    expect(mid.totalTokens).toBeLessThan(target.totalTokens)
  })
})
