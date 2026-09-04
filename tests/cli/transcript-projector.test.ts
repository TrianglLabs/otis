import { describe, expect, it } from "vitest"
import { TranscriptStore } from "../../src/cli/transcript.js"
import { TranscriptProjector } from "../../src/cli/transcript-projector.js"
import type { AgentEvent } from "../../src/core/agent.js"

describe("TranscriptProjector", () => {
  it("streams text into one assistant card and starts a new card after reasoning or tool activity", () => {
    const transcript = new TranscriptStore()
    const projector = new TranscriptProjector(transcript)
    const events: AgentEvent[] = [
      { type: "delta", text: "Looking" },
      { type: "delta", text: " now." },
      { type: "tool", phase: "start", toolCallId: "call_1", name: "read", activityKind: "file_read", label: "Reading" },
      {
        type: "tool",
        phase: "end",
        toolCallId: "call_1",
        name: "read",
        activityKind: "file_read",
        label: "Reading",
        outcome: "completed",
      },
      { type: "delta", text: "Found it." },
      { type: "reasoning", phase: "start", reasoningId: "r1", field: "reasoning_content", startedAt: "now" },
      { type: "reasoning", phase: "delta", reasoningId: "r1", text: "hmm" },
      { type: "reasoning", phase: "end", reasoningId: "r1", endedAt: "later", durationMs: 400 },
      { type: "delta", text: "Final." },
    ]

    const changed = events.map((event) => projector.apply(event))
    projector.finishStreaming()

    // The tool end without a diff and unknown event types leave the transcript untouched.
    expect(changed).toEqual([true, true, true, false, true, true, true, true, true])
    expect(
      transcript.entries.map((entry) => ({ kind: entry.kind, text: entry.text, streaming: entry.streaming })),
    ).toEqual([
      { kind: "message", text: "Looking now.", streaming: false },
      { kind: "tool", text: "Reading", streaming: undefined },
      { kind: "message", text: "Found it.", streaming: false },
      { kind: "reasoning", text: "hmm", streaming: false },
      { kind: "message", text: "Final.", streaming: false },
    ])
    expect(transcript.entries[3]).toMatchObject({ reasoningId: "r1", durationMs: 400 })
  })

  it("attaches diffs to the tool card by call ID and expands debug output line by line", () => {
    const transcript = new TranscriptStore()
    const projector = new TranscriptProjector(transcript)
    projector.apply({
      type: "tool",
      phase: "start",
      toolCallId: "call_edit",
      name: "edit",
      activityKind: "file_edit",
      label: "Editing a.ts",
    })
    projector.apply({ type: "debug", message: "one\ntwo" })
    projector.apply({
      type: "tool",
      phase: "end",
      toolCallId: "call_edit",
      name: "edit",
      activityKind: "file_edit",
      label: "Editing a.ts",
      diff: "--- a.ts\n+++ a.ts",
      outcome: "completed",
    })

    expect(transcript.entries).toMatchObject([
      { kind: "tool", toolCallId: "call_edit", diff: "--- a.ts\n+++ a.ts" },
      { kind: "debug", text: "one" },
      { kind: "debug", text: "two" },
    ])
  })

  it("ignores events that do not belong to the transcript", () => {
    const transcript = new TranscriptStore()
    const projector = new TranscriptProjector(transcript)

    expect(projector.apply({ type: "model", phase: "start" })).toBe(false)
    expect(projector.apply({ type: "context", messageCount: 1, contentChars: 10 })).toBe(false)
    expect(projector.apply({ type: "reasoning", phase: "delta", reasoningId: "unknown", text: "x" })).toBe(false)
    expect(projector.apply({ type: "complete", messages: [] })).toBe(false)
    expect(transcript.entries).toEqual([])
    expect(projector.ensureAssistantEntry()).toMatchObject({ kind: "message", speaker: "Otis", text: "" })
  })
})
