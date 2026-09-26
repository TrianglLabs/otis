import { afterEach, describe, expect, it, vi } from "vitest"

// A desktop launcher entry or a shell pipe that runs plain `otis` has no terminal for the TUI.
describe("CLI without a terminal", () => {
  afterEach(() => {
    process.exitCode = undefined
  })

  it("refuses to start the interactive app and explains how to run otis", async () => {
    vi.resetModules()
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true })
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const start = vi.fn()
    vi.doMock("../../src/cli/interactive-app.js", () => ({ InteractiveApp: { start } }))
    process.argv = [process.argv[0], "otis"]

    await import("../../src/cli/index.js")

    expect(start).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("otis needs an interactive terminal"),
    )
  })
})
