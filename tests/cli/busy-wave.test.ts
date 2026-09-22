import { describe, expect, it } from "vitest"
import { renderBusyWave } from "../../src/cli/ui/color-pulse.js"

/** The one-way travel time of the pulse; a round trip takes twice as long. */
const BUSY_WAVE_ONE_WAY_MS = 1200

describe("renderBusyWave", () => {
  it("renders only the wave at the exact width when no label is given", () => {
    const line = frame(0, 40).text

    expect(line).toHaveLength(40)
    expect(line.trim()).toHaveLength(40)
  })

  it("centers the label inside the wave, keeping the wave on both sides", () => {
    const line = frame(0, 40, "THINKING").text

    expect(line).toHaveLength(40)
    const label = " THINKING "
    const start = Math.floor((40 - label.length) / 2)
    expect(line.indexOf(label)).toBe(start)
    expect(line.slice(0, start).trim().length).toBeGreaterThan(0)
    expect(line.slice(start + label.length).trim().length).toBeGreaterThan(0)
  })

  it("keeps the wave animating behind a static label", () => {
    const first = frame(0, 40, "THINKING")
    const later = frame(400, 40, "THINKING")

    expect(first.levels).not.toEqual(later.levels)
    expect(first.text.indexOf(" THINKING ")).toBe(later.text.indexOf(" THINKING "))
  })

  it("bounces the pulse instead of wrapping around the bar", () => {
    const width = 80
    const spanMs = BUSY_WAVE_ONE_WAY_MS

    expect(peakIndex(frame(0, width).levels)).toBeLessThan(3)
    expect(peakIndex(frame(spanMs, width).levels)).toBeGreaterThan(width - 8)
    expect(peakIndex(frame(spanMs * 2, width).levels)).toBeLessThan(3)

    const start = frame(0, width).levels
    expect(start.at(-1)).toBeLessThan(0.25)
  })

  it("clips the label when the bar is narrower than the label", () => {
    const line = frame(0, 6, "THINKING").text

    expect(line).toHaveLength(6)
    expect(line).toBe(" THINK")
  })

  it("renders the wave at sub-cell widths without crashing", () => {
    expect(frame(0, 1).text).toHaveLength(1)
    expect(frame(0, 1, "THINKING").text).toHaveLength(1)
  })

  it("falls back to a minimum wave width before the layout width is known", () => {
    const line = frame(0, Number.NaN).text

    expect(line.length).toBeGreaterThan(0)
    expect(line.trim().length).toBeGreaterThan(0)
    expect(frame(0, Number.NaN, "THINKING").text).toContain("THINKING")
  })
})

/** Renders in grayscale so each cell's brightness (0..1) reads back as its pulse intensity. */
function frame(elapsedMs: number, width: number, label?: string) {
  const chunks = renderBusyWave(elapsedMs, width, "#ffffff", "#000000", label).chunks
  return {
    text: chunks.map((chunk) => chunk.text).join(""),
    levels: chunks.flatMap((chunk) =>
      Array.from(chunk.text, () => (chunk.fg?.toInts()[0] ?? 0) / 255),
    ),
  }
}

function peakIndex(levels: number[]) {
  return levels.indexOf(Math.max(...levels))
}
