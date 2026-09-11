// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { applyStoredTheme, rememberTheme } from "../../../src/desktop/renderer/theme.js"

describe("boot-time theme", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    document.documentElement.removeAttribute("data-theme")
  })

  it("applies the remembered theme before first paint", () => {
    const storage = new Map<string, string>()
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    })
    rememberTheme("matrix")
    applyStoredTheme()
    expect(document.documentElement.dataset.theme).toBe("matrix")
  })

  it("boots in the default theme when nothing is remembered", () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} })
    applyStoredTheme()
    expect(document.documentElement.dataset.theme).toBeUndefined()
  })

  it("never throws when storage is unavailable", () => {
    vi.stubGlobal("localStorage", undefined)
    expect(() => rememberTheme("nord")).not.toThrow()
    expect(() => applyStoredTheme()).not.toThrow()
    expect(document.documentElement.dataset.theme).toBeUndefined()
  })

  it("never throws when storage fails", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied")
      },
      setItem: () => {
        throw new Error("denied")
      },
    })
    expect(() => rememberTheme("nord")).not.toThrow()
    expect(() => applyStoredTheme()).not.toThrow()
    expect(document.documentElement.dataset.theme).toBeUndefined()
  })
})
