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

  it("wraps subagent events with their delegating call in jsonl and indents their tools in plain mode", async () => {
    let jsonl = ""
    let plainStderr = ""
    const jsonlReporter = new HeadlessReporter(
      "jsonl",
      { write: (chunk: string) => (jsonl += chunk) },
      { write: () => true },
    )
    const plainReporter = new HeadlessReporter(
      "plain",
      { write: () => true },
      { write: (chunk: string) => (plainStderr += chunk) },
    )
    const events = [
      {
        type: "tool" as const,
        phase: "start" as const,
        toolCallId: "call_agent",
        name: "agent" as const,
        activityKind: "agent" as const,
        label: "Delegating: Map the notes",
      },
      {
        type: "subagent" as const,
        toolCallId: "call_agent",
        title: "Map the notes",
        event: {
          type: "tool" as const,
          phase: "start" as const,
          toolCallId: "call_read",
          name: "read" as const,
          activityKind: "file_read" as const,
          label: "Reading files: note.txt",
        },
      },
      {
        type: "subagent" as const,
        toolCallId: "call_agent",
        title: "Map the notes",
        event: { type: "delta" as const, text: "Child report." },
      },
      {
        type: "subagent" as const,
        toolCallId: "call_agent",
        title: "Map the notes",
        event: {
          type: "reasoning" as const,
          phase: "start" as const,
          reasoningId: "r1",
          field: "reasoning_content" as const,
          startedAt: "now",
        },
      },
    ]
    for (const event of events) {
      await jsonlReporter.event(event)
      await plainReporter.event(event)
    }

    const lines = jsonl
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatchObject({ type: "tool_start", toolCallId: "call_agent", name: "agent" })
    expect(lines[1]).toMatchObject({
      type: "subagent",
      toolCallId: "call_agent",
      title: "Map the notes",
      event: { type: "tool_start", toolCallId: "call_read", name: "read" },
    })
    expect(lines[2]).toMatchObject({ type: "subagent", event: { type: "assistant_delta", text: "Child report." } })
    expect(plainStderr).toBe("→ Delegating: Map the notes\n  → Reading files: note.txt\n")
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
