import { describe, expect, it } from "vitest"
import { renderBusyStatus } from "../../src/cli/ui/format.js"

describe("renderBusyStatus", () => {
  it("renders only the wave at the exact width when no label is given", () => {
    const line = renderBusyStatus(0, 40)

    expect(line).toHaveLength(40)
    expect(line.trim()).toHaveLength(40)
  })

  it("centers the label inside the wave, keeping the wave on both sides", () => {
    const line = renderBusyStatus(0, 40, "THINKING")

    expect(line).toHaveLength(40)
    const label = " THINKING "
    const start = Math.floor((40 - label.length) / 2)
    expect(line.indexOf(label)).toBe(start)
    expect(line.slice(0, start).trim().length).toBeGreaterThan(0)
    expect(line.slice(start + label.length).trim().length).toBeGreaterThan(0)
  })

  it("keeps the wave animating behind a static label", () => {
    const first = renderBusyStatus(0, 40, "THINKING")
    const later = renderBusyStatus(3, 40, "THINKING")

    expect(first).not.toBe(later)
    expect(first.indexOf(" THINKING ")).toBe(later.indexOf(" THINKING "))
  })

  it("clips the label when the bar is narrower than the label", () => {
    const line = renderBusyStatus(0, 6, "THINKING")

    expect(line).toHaveLength(6)
    expect(line).toBe(" THINK")
  })

  it("renders the wave at sub-cell widths without crashing", () => {
    expect(renderBusyStatus(0, 1)).toHaveLength(1)
    expect(renderBusyStatus(0, 1, "THINKING")).toHaveLength(1)
  })

  it("falls back to a minimum wave width before the layout width is known", () => {
    const line = renderBusyStatus(0, Number.NaN)

    expect(line.length).toBeGreaterThan(0)
    expect(line.trim().length).toBeGreaterThan(0)
    expect(renderBusyStatus(0, Number.NaN, "THINKING")).toContain("THINKING")
  })
})
