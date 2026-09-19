import { describe, expect, it } from "vitest"
import { formatTokenCount } from "../../../src/desktop/renderer/format.js"

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
})
