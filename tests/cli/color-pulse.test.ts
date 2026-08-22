import { describe, expect, it } from "vitest"
import { colors } from "../../src/cli/theme.js"
import { COLOR_PULSE_PERIOD_MS, colorPulseAmount, selectionOutline } from "../../src/cli/ui/color-pulse.js"

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
})
