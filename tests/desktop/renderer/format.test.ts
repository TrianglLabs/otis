import { describe, expect, it } from "vitest"
import { formatContextWindow, formatTokenCount } from "../../../src/desktop/renderer/format.js"

describe("desktop display formatting", () => {
  it("formats billion-scale token counts in billions", () => {
    expect(formatTokenCount(1_211_800_000)).toBe("1.2B")
    expect(formatTokenCount(1_201_800_000)).toBe("1.2B")
  })

  it("keeps smaller token counts in their existing units", () => {
    expect(formatTokenCount(999_900_000)).toBe("999.9M")
    expect(formatTokenCount(1_482_300)).toBe("1.5M")
    expect(formatTokenCount(44_000)).toBe("44.0k")
  })

  it("labels context windows like the picker catalog", () => {
    expect(formatContextWindow(131_072)).toBe("128K")
    expect(formatContextWindow(128_000)).toBe("128K")
    expect(formatContextWindow(193_536)).toBe("189K")
    expect(formatContextWindow(200_000)).toBe("200K")
    expect(formatContextWindow(65_535)).toBe("~64K")
    expect(formatContextWindow(1_048_576)).toBe("1M")
  })
})
