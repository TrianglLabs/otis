import { describe, expect, it } from "vitest"
import { colors } from "../../src/cli/theme.js"
import { colorPulseAmount, selectionOutline, shimmerText } from "../../src/cli/ui/color-pulse.js"

const COLOR_PULSE_PERIOD_MS = 2400
const TEXT_SHIMMER_PERIOD_MS = 1300

describe("color pulse", () => {
  it("eases from rest to peak and back over one period", () => {
    expect(colorPulseAmount(0)).toBeCloseTo(0)
    expect(colorPulseAmount(COLOR_PULSE_PERIOD_MS / 2)).toBeCloseTo(1)
    expect(colorPulseAmount(COLOR_PULSE_PERIOD_MS)).toBeCloseTo(0)
  })

  it("keeps the selection outline visible at rest and accent at peak", () => {
    expect(selectionOutline(0)).not.toBe(colors.accent)
    expect(selectionOutline(0)).not.toBe(colors.surface)
    expect(selectionOutline(1)).toBe(colors.accent)
  })

  it("sweeps a highlight through loading text", () => {
    const start = shimmerLevels("loading", 0)
    const mid = shimmerLevels("loading", TEXT_SHIMMER_PERIOD_MS / 2)
    expect(peakIndex(start)).toBeLessThan(peakIndex(mid))
    expect(start).not.toEqual(mid)
    expect(shimmerLevels("loading", TEXT_SHIMMER_PERIOD_MS)).toEqual(start)
  })
})

/** Shimmers from black to white so each letter's brightness reads back as its highlight amount. */
function shimmerLevels(text: string, elapsedMs: number) {
  return shimmerText(text, elapsedMs, "#000000", "#ffffff").chunks.map(
    (chunk) => chunk.fg?.toInts()[0] ?? 0,
  )
}

function peakIndex(levels: number[]) {
  return levels.indexOf(Math.max(...levels))
}
