import { describe, expect, it, vi } from "vitest"
import { HeadlessReporter } from "../../src/cli/headless-output.js"

describe("HeadlessReporter", () => {
  it("waits for stdout backpressure before completing an event write", async () => {
    let drain: (() => void) | undefined
    const stdout = {
      write: vi.fn(() => false),
      once: vi.fn((_event: "drain", listener: () => void) => {
        drain = listener
      }),
    }
    const reporter = new HeadlessReporter("jsonl", stdout, { write: () => true })
    let completed = false

    const pending = reporter.event({ type: "delta", text: "hello" }).then(() => {
      completed = true
    })
    await Promise.resolve()

    expect(completed).toBe(false)
    expect(stdout.once).toHaveBeenCalledWith("drain", expect.any(Function))
    drain?.()
    await pending
    expect(completed).toBe(true)
  })
})
