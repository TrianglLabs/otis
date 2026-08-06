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

  it("includes completed reasoning only when explicitly requested", async () => {
    let stdout = ""
    const reporter = new HeadlessReporter(
      "json",
      { write: (chunk: string) => (stdout += chunk) },
      { write: () => true },
      { includeReasoning: true },
    )
    await reporter.event({
      type: "reasoning",
      phase: "start",
      reasoningId: "reasoning_1",
      field: "reasoning_content",
      startedAt: "2026-08-06T12:00:00.000Z",
    })
    await reporter.event({ type: "reasoning", phase: "delta", reasoningId: "reasoning_1", text: "Check it." })
    await reporter.event({
      type: "reasoning",
      phase: "end",
      reasoningId: "reasoning_1",
      endedAt: "2026-08-06T12:00:00.500Z",
      durationMs: 500,
    })
    await reporter.finish({
      status: "complete",
      output: "Done.",
      model: "test",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      durationMs: 1,
    })

    expect(JSON.parse(stdout)).toMatchObject({
      reasoning: [
        {
          id: "reasoning_1",
          field: "reasoning_content",
          text: "Check it.",
          durationMs: 500,
        },
      ],
    })
  })
})
