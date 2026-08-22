import { describe, expect, it } from "vitest"
import { busyWave } from "../../src/cli/ui/busy-wave.js"

describe("busyWave", () => {
  it("renders only the wave at the exact width when no label is given", () => {
    const line = busyWave(0, 40).text

    expect(line).toHaveLength(40)
    expect(line.trim()).toHaveLength(40)
  })

  it("centers the label inside the wave, keeping the wave on both sides", () => {
    const line = busyWave(0, 40, "THINKING").text

    expect(line).toHaveLength(40)
    const label = " THINKING "
    const start = Math.floor((40 - label.length) / 2)
    expect(line.indexOf(label)).toBe(start)
    expect(line.slice(0, start).trim().length).toBeGreaterThan(0)
    expect(line.slice(start + label.length).trim().length).toBeGreaterThan(0)
  })

  it("keeps the wave animating behind a static label", () => {
    const first = busyWave(0, 40, "THINKING")
    const later = busyWave(400, 40, "THINKING")

    expect(first.intensities).not.toEqual(later.intensities)
    expect(first.text.indexOf(" THINKING ")).toBe(later.text.indexOf(" THINKING "))
  })

  it("keeps adjacent cells close in intensity so the wave stays smooth", () => {
    const { intensities } = busyWave(0, 80)

    expect(intensities).toHaveLength(80)
    for (let index = 1; index < intensities.length; index += 1) {
      expect(Math.abs(intensities[index] - intensities[index - 1])).toBeLessThan(0.25)
    }
  })

  it("clips the label when the bar is narrower than the label", () => {
    const line = busyWave(0, 6, "THINKING").text

    expect(line).toHaveLength(6)
    expect(line).toBe(" THINK")
  })

  it("renders the wave at sub-cell widths without crashing", () => {
    expect(busyWave(0, 1).text).toHaveLength(1)
    expect(busyWave(0, 1, "THINKING").text).toHaveLength(1)
  })

  it("falls back to a minimum wave width before the layout width is known", () => {
    const line = busyWave(0, Number.NaN).text

    expect(line.length).toBeGreaterThan(0)
    expect(line.trim().length).toBeGreaterThan(0)
    expect(busyWave(0, Number.NaN, "THINKING").text).toContain("THINKING")
  })
})
