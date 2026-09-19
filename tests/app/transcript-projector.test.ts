import { describe, expect, it } from "vitest"
import { TranscriptStore } from "../../src/app/transcript.js"
import { TranscriptProjector } from "../../src/app/transcript-projector.js"
import type { AgentEvent } from "../../src/core/agent.js"

describe("TranscriptProjector", () => {
  it("separates partial output from the next model attempt without adding an error message", () => {
    const transcript = new TranscriptStore()
    const projector = new TranscriptProjector(transcript)
    projector.apply({ type: "delta", text: "Partial response" })
    expect(projector.apply({ type: "model", phase: "retry" })).toBe(true)
    projector.apply({ type: "delta", text: "Recovered response" })
    expect(transcript.entries).toMatchObject([
      { text: "Partial response", streaming: false },
      { text: "Recovered response", streaming: true },
    ])
  })

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

  it("holds artifact cards until the turn ends and reveals only the latest revision", () => {
    const transcript = new TranscriptStore()
    const projector = new TranscriptProjector(transcript)
    const artifact = { source: "workspace" as const, path: "brief.md", kind: "markdown" as const }

    for (const toolCallId of ["write_1", "write_2"]) {
      projector.apply({
        type: "tool",
        phase: "start",
        toolCallId,
        name: "write",
        activityKind: "file_write",
        label: "Writing brief.md",
      })
      projector.apply({
        type: "tool",
        phase: "end",
        toolCallId,
        name: "write",
        activityKind: "file_write",
        label: "Writing brief.md",
        artifact,
        outcome: "completed",
      })
    }

    expect(transcript.entries.map((entry) => entry.artifactDisplay)).toEqual(["superseded", "pending"])
    projector.finishTurn()
    expect(transcript.entries.map((entry) => entry.artifactDisplay)).toEqual(["superseded", "ready"])
  })

  it("ignores events that do not belong to the transcript", () => {
    const transcript = new TranscriptStore()
    const projector = new TranscriptProjector(transcript)

    expect(projector.apply({ type: "model", phase: "start" })).toBe(false)
    expect(projector.apply({ type: "context", messageCount: 1, contentChars: 10, tokens: 1_000 })).toBe(false)
    expect(projector.apply({ type: "reasoning", phase: "delta", reasoningId: "unknown", text: "x" })).toBe(false)
    expect(projector.apply({ type: "complete", messages: [] })).toBe(false)
    expect(transcript.entries).toEqual([])
    expect(projector.ensureAssistantEntry()).toMatchObject({ kind: "message", speaker: "Otis", text: "" })
  })

  it("keeps revisions pending through steering and compaction in the same turn", () => {
    const transcript = new TranscriptStore()
    let projector = new TranscriptProjector(transcript)
    const artifact = {
      source: "published" as const,
      artifactId: "12345678-1234-1234-1234-123456789abc",
      version: 1,
      sha256: "a".repeat(64),
      sourcePath: "/workspace/brief.md",
      name: "brief.md",
      kind: "markdown" as const,
    }
    const publish = (version: number) => {
      const tool = {
        type: "tool" as const,
        toolCallId: `publish_${version}`,
        name: "publish_artifact" as const,
        activityKind: "file_read" as const,
        label: "Publishing brief.md",
      }
      projector.apply({ ...tool, phase: "start" })
      projector.apply({ ...tool, phase: "end", outcome: "completed", artifact: { ...artifact, version } })
    }
    transcript.addUserMessage("Draft the brief")
    publish(1)
    const steering = transcript.addSteeringUserMessage("Make it shorter")
    transcript.activatePendingUserMessage(steering.id)
    transcript.addQueuedUserMessage("Next task")
    expect(transcript.entries.find((entry) => entry.artifact)?.artifactDisplay).toBe("pending")
    transcript.loadCompacted("Drafted the brief", [])
    projector = new TranscriptProjector(transcript)
    publish(2)
    expect(transcript.entries.filter((entry) => entry.artifact).map((entry) => entry.artifactDisplay)).toEqual([
      "superseded",
      "pending",
    ])
    projector.finishTurn()
    expect(
      transcript.entries.filter((entry) => entry.artifactDisplay === "ready").map((entry) => entry.artifact),
    ).toEqual([{ ...artifact, version: 2 }])
  })
})
