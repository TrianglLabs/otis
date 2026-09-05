import { describe, expect, it } from "vitest"
import { contextUsage } from "../../src/app/context-usage.js"
import { formatContextUsage } from "../../src/cli/context-meter.js"

describe("formatContextUsage", () => {
  it("renders an empty thin track at 0%", () => {
    expect(formatContextUsage(contextUsage(0, 100_000))).toBe("────────── 0% · ~0")
  })

  it("shows a start tick as soon as any context is used", () => {
    expect(formatContextUsage(contextUsage(400, 100_000))).toBe("╺───────── <1% · ~400")
  })

  it("fills from the left with a tip on the half-cell", () => {
    expect(formatContextUsage(contextUsage(50_000, 100_000))).toBe("━━━━━───── 50% · ~50k")
    expect(formatContextUsage(contextUsage(55_000, 100_000))).toBe("━━━━━╸──── 55% · ~55k")
  })

  it("renders a solid track at 100%", () => {
    expect(formatContextUsage(contextUsage(250_000, 250_000))).toBe("━━━━━━━━━━ 100% · ~250k")
  })
})
