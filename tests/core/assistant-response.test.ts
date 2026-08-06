import { describe, expect, it } from "vitest"
import { AssistantResponseBuilder } from "../../src/core/assistant-response.js"

describe("AssistantResponseBuilder", () => {
  it("coalesces adjacent deltas while preserving reasoning and text block order", () => {
    const times = [
      new Date("2026-08-06T12:00:00.000Z"),
      new Date("2026-08-06T12:00:00.500Z"),
      new Date("2026-08-06T12:00:01.000Z"),
      new Date("2026-08-06T12:00:02.000Z"),
    ]
    let nextId = 0
    const builder = new AssistantResponseBuilder({
      createId: () => {
        nextId += 1
        return `reasoning_${nextId}`
      },
      now: () => times.shift() ?? new Date("2026-08-06T12:00:02.000Z"),
    })

    expect(builder.appendReasoning("First ", "reasoning_content")).toMatchObject([
      { phase: "start", reasoningId: "reasoning_1" },
      { phase: "delta", reasoningId: "reasoning_1", text: "First " },
    ])
    expect(builder.appendReasoning("thought.", "reasoning_content")).toMatchObject([
      { phase: "delta", reasoningId: "reasoning_1", text: "thought." },
    ])
    expect(builder.appendText("Interim. ")).toMatchObject([
      { phase: "end", reasoningId: "reasoning_1", durationMs: 500 },
    ])
    expect(builder.appendText("More.")).toEqual([])
    expect(builder.appendReasoning("Second thought.", "reasoning_text")).toMatchObject([
      { phase: "start", reasoningId: "reasoning_2" },
      { phase: "delta", reasoningId: "reasoning_2", text: "Second thought." },
    ])
    expect(builder.finish()).toMatchObject([{ phase: "end", reasoningId: "reasoning_2", durationMs: 1_000 }])

    expect(builder.content).toEqual([
      {
        type: "reasoning",
        id: "reasoning_1",
        field: "reasoning_content",
        text: "First thought.",
        startedAt: "2026-08-06T12:00:00.000Z",
        endedAt: "2026-08-06T12:00:00.500Z",
      },
      { type: "text", text: "Interim. More." },
      {
        type: "reasoning",
        id: "reasoning_2",
        field: "reasoning_text",
        text: "Second thought.",
        startedAt: "2026-08-06T12:00:01.000Z",
        endedAt: "2026-08-06T12:00:02.000Z",
      },
    ])
  })
})
