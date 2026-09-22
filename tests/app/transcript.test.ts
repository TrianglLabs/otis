import { describe, expect, it } from "vitest"
import {
  type TranscriptChange,
  TranscriptProjector,
  TranscriptStore,
} from "../../src/app/transcript.js"
import type { AgentEvent } from "../../src/core/agent.js"

describe("TranscriptStore", () => {
  it("records transcript entries in insertion order with stable IDs", () => {
    const transcript = new TranscriptStore()

    const user = transcript.addUserMessage("hello")
    const assistant = transcript.addAssistantMessage("hi")
    const tool = transcript.addToolMessage("Reading files", "file_read")
    const debug = transcript.addDebugMessage("raw event")

    expect(transcript.entries).toEqual([
      { id: 1, kind: "message", speaker: "You", text: "hello" },
      { id: 2, kind: "message", speaker: "Otis", text: "hi" },
      { id: 3, kind: "tool", speaker: "Tool", text: "Reading files", activityKind: "file_read" },
      { id: 4, kind: "debug", speaker: "Debug", text: "raw event" },
    ])
    expect([user.id, assistant.id, tool.id, debug.id]).toEqual([1, 2, 3, 4])
  })

  it("updates existing entries without mutating missing IDs", () => {
    const transcript = new TranscriptStore()
    const entry = transcript.addAssistantMessage("partial")

    transcript.updateEntry(entry.id, { text: "complete", streaming: false })
    transcript.updateEntry(999, { text: "missing" })

    expect(transcript.entries).toEqual([
      { id: 1, kind: "message", speaker: "Otis", text: "complete", streaming: false },
    ])
  })

  it("keeps artifact revisions in history but reveals only the last revision when the turn settles", () => {
    const transcript = new TranscriptStore()
    const first = transcript.addToolMessage("Writing brief.md", "file_write", {
      toolCallId: "write_1",
    })
    const second = transcript.addToolMessage("Editing brief.md", "file_edit", {
      toolCallId: "edit_1",
    })
    const artifact = { source: "workspace" as const, path: "brief.md", kind: "markdown" as const }

    transcript.stageArtifact(first.id, artifact)
    expect(first.artifact).toBeUndefined()
    expect(transcript.entries[0]).toMatchObject({ artifact, artifactDisplay: "pending" })

    transcript.stageArtifact(second.id, artifact)
    expect(transcript.entries).toMatchObject([
      { artifact, artifactDisplay: "superseded" },
      { artifact, artifactDisplay: "pending" },
    ])

    expect(transcript.finalizeArtifacts()).toBe(true)
    expect(transcript.entries).toMatchObject([
      { artifact, artifactDisplay: "superseded" },
      { artifact, artifactDisplay: "ready" },
    ])
  })

  it("reveals the final revision of each distinct artifact", () => {
    const transcript = new TranscriptStore()
    const brief = transcript.addToolMessage("Writing brief.md", "file_write")
    const notes = transcript.addToolMessage("Writing notes.md", "file_write")

    transcript.stageArtifact(brief.id, { source: "workspace", path: "brief.md", kind: "markdown" })
    transcript.stageArtifact(notes.id, { source: "workspace", path: "notes.md", kind: "markdown" })
    transcript.finalizeArtifacts()

    expect(transcript.entries.map((entry) => entry.artifactDisplay)).toEqual(["ready", "ready"])
  })

  it("moves a queued user message to the active transcript position", () => {
    const transcript = new TranscriptStore()
    transcript.addUserMessage("active")
    const queued = transcript.addQueuedUserMessage("follow-up")
    transcript.addAssistantMessage("active done")

    expect(queued).toMatchObject({ speaker: "You", text: "follow-up", delivery: "queued" })

    transcript.activatePendingUserMessage(queued.id)

    expect(transcript.entries).toEqual([
      { id: 1, kind: "message", speaker: "You", text: "active" },
      { id: 3, kind: "message", speaker: "Otis", text: "active done" },
      { id: 2, kind: "message", speaker: "You", text: "follow-up" },
    ])
  })

  it("projects attached documents as reopenable artifacts while preserving terminal display text", () => {
    const transcript = new TranscriptStore()
    transcript.addUserMessage({
      role: "user",
      content: [
        {
          type: "document",
          kind: "pdf",
          data: "JVBERg==",
          extractedText: "Product brief",
          mimeType: "application/pdf",
          name: "brief.pdf",
          sizeBytes: 5,
          sha256: "a".repeat(64),
          truncated: false,
        },
        { type: "text", text: "Review this" },
      ],
    })

    expect(transcript.entries[0]).toMatchObject({
      text: "Review this\n📄 brief.pdf",
      messageText: "Review this",
      artifacts: [
        {
          source: "attachment",
          sha256: "a".repeat(64),
          name: "brief.pdf",
          kind: "pdf",
          mimeType: "application/pdf",
        },
      ],
    })
  })

  it("reconstructs tool cards from older sessions without activity metadata", () => {
    const transcript = new TranscriptStore()
    const messages = [
      { role: "user" as const, content: "hello" },
      {
        role: "assistant" as const,
        content: [
          { type: "text" as const, text: "I'll check." },
          {
            type: "tool_call" as const,
            toolCall: { id: "call_1", name: "read", arguments: '{"path":"a.txt"}' },
          },
        ],
      },
      { role: "tool" as const, toolCallId: "call_1", content: "read: a.txt\n\ncontents" },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "Done." }] },
    ]

    transcript.loadMessages(messages)

    expect(transcript.history).toEqual(messages)
    expect(transcript.entries).toEqual([
      { id: 1, kind: "message", speaker: "You", text: "hello" },
      { id: 2, kind: "message", speaker: "Otis", text: "I'll check." },
      {
        id: 3,
        kind: "tool",
        speaker: "Tool",
        text: "Reading files: a.txt",
        activityKind: "file_read",
        toolCallId: "call_1",
      },
      { id: 4, kind: "message", speaker: "Otis", text: "Done." },
    ])
  })

  it("reconstructs reasoning, text, and tools in persisted content order", () => {
    const transcript = new TranscriptStore()
    transcript.loadMessages([
      { role: "user", content: "inspect" },
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            id: "reasoning_1",
            field: "reasoning_content",
            text: "I should inspect the file.",
            startedAt: "2026-08-06T12:00:00.000Z",
            endedAt: "2026-08-06T12:00:01.250Z",
          },
          { type: "text", text: "I'll inspect it." },
          {
            type: "tool_call",
            toolCall: { id: "call_1", name: "read", arguments: '{"path":"a.txt"}' },
          },
        ],
      },
    ])

    expect(transcript.entries).toMatchObject([
      { kind: "message", speaker: "You", text: "inspect" },
      {
        kind: "reasoning",
        speaker: "Thinking",
        reasoningId: "reasoning_1",
        text: "I should inspect the file.",
        durationMs: 1_250,
      },
      { kind: "message", speaker: "Otis", text: "I'll inspect it." },
      { kind: "tool", toolCallId: "call_1", text: "Reading files: a.txt" },
    ])
  })

  it("replays persisted tool diffs by tool-call ID and preserves message order", () => {
    const transcript = new TranscriptStore()
    const messages = [
      { role: "user" as const, content: "edit both files" },
      {
        role: "assistant" as const,
        content: [
          { type: "text" as const, text: "I'll update both." },
          {
            type: "tool_call" as const,
            toolCall: {
              id: "call_1",
              name: "edit",
              arguments: '{"path":"one.ts","old":"a","new":"b"}',
            },
          },
          {
            type: "tool_call" as const,
            toolCall: {
              id: "call_2",
              name: "edit",
              arguments: '{"path":"two.ts","old":"a","new":"b"}',
            },
          },
        ],
      },
      { role: "tool" as const, toolCallId: "call_1", content: "edit: one.ts\n\nupdated" },
      { role: "tool" as const, toolCallId: "call_2", content: "edit: two.ts\n\nupdated" },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "Done." }] },
    ]
    const toolActivities = [
      {
        toolCallId: "call_2",
        activityKind: "file_edit" as const,
        label: "Editing file: two.ts",
        diff: "--- two.ts\n+++ two.ts\n-old\n+new",
      },
      {
        toolCallId: "call_1",
        activityKind: "file_edit" as const,
        label: "Editing file: one.ts",
        diff: "--- one.ts\n+++ one.ts\n-old\n+new",
      },
    ]

    transcript.loadMessages(messages, toolActivities)

    expect(
      transcript.entries.map((entry) => ({ text: entry.text, toolCallId: entry.toolCallId })),
    ).toEqual([
      { text: "edit both files", toolCallId: undefined },
      { text: "I'll update both.", toolCallId: undefined },
      { text: "Editing file: one.ts", toolCallId: "call_1" },
      { text: "Editing file: two.ts", toolCallId: "call_2" },
      { text: "Done.", toolCallId: undefined },
    ])
    expect(transcript.entries[2].diff).toContain("--- one.ts")
    expect(transcript.entries[3].diff).toContain("--- two.ts")
    expect(transcript.toolActivitiesFor(messages)).toEqual([toolActivities[1], toolActivities[0]])
  })

  it("replays one final artifact card per artifact and user turn", () => {
    const transcript = new TranscriptStore()
    const messages = [
      { role: "user" as const, content: "Draft the brief" },
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool_call" as const,
            toolCall: {
              id: "write_1",
              name: "write",
              arguments: '{"path":"brief.md","content":"one"}',
            },
          },
          {
            type: "tool_call" as const,
            toolCall: {
              id: "write_2",
              name: "write",
              arguments: '{"path":"brief.md","content":"two"}',
            },
          },
        ],
      },
      { role: "tool" as const, toolCallId: "write_1", content: "written" },
      { role: "tool" as const, toolCallId: "write_2", content: "written" },
      { role: "user" as const, content: "Revise it" },
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool_call" as const,
            toolCall: {
              id: "write_3",
              name: "write",
              arguments: '{"path":"brief.md","content":"three"}',
            },
          },
        ],
      },
      { role: "tool" as const, toolCallId: "write_3", content: "written" },
    ]
    const artifact = { source: "workspace" as const, path: "brief.md", kind: "markdown" as const }
    const activities = ["write_1", "write_2", "write_3"].map((toolCallId) => ({
      toolCallId,
      activityKind: "file_write" as const,
      label: "Writing brief.md",
      artifact,
    }))

    transcript.replaceMessages(messages, [
      { messages: messages.slice(0, 4), toolActivities: activities.slice(0, 2) },
      { messages: messages.slice(4), toolActivities: activities.slice(2) },
    ])

    const artifactEntries = transcript.entries.filter((entry) => entry.artifact)
    expect(artifactEntries.map((entry) => entry.artifactDisplay)).toEqual([
      "superseded",
      "ready",
      "ready",
    ])
    expect(
      transcript.toolActivitiesFor(messages).filter((activity) => activity.artifact),
    ).toHaveLength(3)
  })

  it("retains the latest matching activity when tool-call IDs repeat across compacted turns", () => {
    const transcript = new TranscriptStore()
    const firstTurn = toolTurn("first", "old.ts")
    const secondTurn = toolTurn("second", "new.ts")
    const activities = [
      {
        toolCallId: "call_0",
        activityKind: "file_edit" as const,
        label: "Editing file: old.ts",
        diff: "old diff",
      },
      {
        toolCallId: "call_0",
        activityKind: "file_edit" as const,
        label: "Editing file: new.ts",
        diff: "new diff",
      },
    ]

    transcript.loadMessages([...firstTurn, ...secondTurn], activities)

    expect(transcript.toolActivitiesFor(secondTurn)).toEqual([activities[1]])
  })

  it("replaces replayed history when switching sessions", () => {
    const transcript = new TranscriptStore()

    transcript.loadMessages([{ role: "user", content: "old" }])
    transcript.replaceMessages([{ role: "user", content: "new" }])

    expect(transcript.history).toEqual([{ role: "user", content: "new" }])
    expect(transcript.entries).toEqual([{ id: 1, kind: "message", speaker: "You", text: "new" }])
  })

  it("compacts model history while preserving existing scrollback exactly once", () => {
    const transcript = new TranscriptStore()

    transcript.loadMessages([
      { role: "user", content: "old question" },
      { role: "assistant", content: [{ type: "text", text: "old answer" }] },
    ])

    const keptMessages = [
      { role: "user" as const, content: "recent question" },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "recent answer" }] },
    ]

    transcript.loadMessages(keptMessages)
    const previous = [...transcript.entries]
    transcript.loadCompacted("## Goal\nDo the thing", keptMessages)

    expect(transcript.history).toEqual([
      { role: "user", content: "[Compacted conversation summary]\n\n## Goal\nDo the thing" },
      { role: "user", content: "recent question" },
      { role: "assistant", content: [{ type: "text", text: "recent answer" }] },
    ])

    expect(transcript.entries).toEqual(previous)
    expect(transcript.entries[0]).toBe(previous[0])
  })

  it("preserves pending prompt identities when model history is compacted", () => {
    const transcript = new TranscriptStore()
    transcript.loadMessages([{ role: "user", content: "old task" }])
    const queued = transcript.addQueuedUserMessage("queued task")
    const steering = transcript.addSteeringUserMessage("new direction")
    transcript.loadCompacted("Summary.", [
      { role: "assistant", content: [{ type: "text", text: "Kept." }] },
    ])
    expect(new Set(transcript.entries.map((entry) => entry.id)).size).toBe(
      transcript.entries.length,
    )
    expect(transcript.activatePendingUserMessage(queued.id)).toBe(true)
    expect(transcript.activatePendingUserMessage(steering.id)).toBe(true)
    expect(transcript.entries.slice(-2).map((entry) => entry.text)).toEqual([
      "queued task",
      "new direction",
    ])
    expect(transcript.entries.some((entry) => entry.delivery)).toBe(false)
  })

  it("keeps compaction summaries in model context without displaying them on session reload", () => {
    const transcript = new TranscriptStore()
    const messages = [
      {
        role: "user" as const,
        content: "[Compacted conversation summary]\n\n## Goal\nDo the thing",
      },
      { role: "user" as const, content: "recent question" },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "recent answer" }] },
    ]

    transcript.loadMessages(messages)

    expect(transcript.history).toEqual(messages)
    expect(transcript.entries).toEqual([
      { id: 1, kind: "message", speaker: "You", text: "recent question" },
      { id: 2, kind: "message", speaker: "Otis", text: "recent answer" },
    ])
  })
})

function toolTurn(prompt: string, path: string) {
  return [
    { role: "user" as const, content: prompt },
    {
      role: "assistant" as const,
      content: [
        {
          type: "tool_call" as const,
          toolCall: {
            id: "call_0",
            name: "edit",
            arguments: `{"path":"${path}","old":"a","new":"b"}`,
          },
        },
      ],
    },
    { role: "tool" as const, toolCallId: "call_0", content: "updated" },
  ]
}

function watch(store: TranscriptStore) {
  const changes: TranscriptChange[] = []
  const unsubscribe = store.subscribe((change) => changes.push(change))
  return { changes, unsubscribe }
}

describe("TranscriptStore change notifications", () => {
  it("replaces model context without publishing the compaction summary or resetting scrollback", () => {
    const store = new TranscriptStore()
    store.loadMessages([{ role: "user", content: "original task" }])
    const entries = [...store.entries]
    const { changes } = watch(store)

    store.loadCompacted("Internal summary", [])

    expect(changes).toEqual([])
    expect(store.entries).toEqual(entries)
    expect(store.history[0].content).toContain("Internal summary")
  })

  it("emits upsert for new and updated entries", () => {
    const store = new TranscriptStore()
    const { changes } = watch(store)

    const entry = store.addAssistantMessage("hello")
    store.updateEntry(entry.id, { text: "hello world", streaming: false })

    expect(changes).toEqual([
      { op: "upsert", id: entry.id },
      { op: "upsert", id: entry.id },
    ])
  })

  it("emits reset before replayed entries when messages are replaced", () => {
    const store = new TranscriptStore()
    store.addAssistantMessage("old")
    const { changes } = watch(store)

    store.replaceMessages([{ role: "user", content: "fresh" }])

    expect(changes[0]).toEqual({ op: "reset" })
    expect(changes.slice(1)).toEqual([{ op: "upsert", id: 1 }])
    expect(store.entries.map((entry) => entry.text)).toEqual(["fresh"])
  })

  it("emits remove then upsert when a queued message activates, moving it to the end", () => {
    const store = new TranscriptStore()
    const queued = store.addQueuedUserMessage("follow up")
    store.addAssistantMessage("working…")
    const { changes } = watch(store)

    expect(store.activatePendingUserMessage(queued.id)).toBe(true)

    expect(changes).toEqual([
      { op: "remove", id: queued.id },
      { op: "upsert", id: queued.id },
    ])
    expect(store.entries.at(-1)?.id).toBe(queued.id)
    expect(store.entries.at(-1)?.delivery).toBeUndefined()
  })

  it("emits remove and stops notifying after unsubscribe", () => {
    const store = new TranscriptStore()
    const entry = store.addAssistantMessage("gone")
    const { changes, unsubscribe } = watch(store)
    changes.length = 0

    expect(store.removeEntry(entry.id)).toBe(true)
    unsubscribe()
    store.addAssistantMessage("not observed")

    expect(changes).toEqual([{ op: "remove", id: entry.id }])
  })
})

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
      {
        type: "tool",
        phase: "start",
        toolCallId: "call_1",
        name: "read",
        activityKind: "file_read",
        label: "Reading",
      },
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
      {
        type: "reasoning",
        phase: "start",
        reasoningId: "r1",
        field: "reasoning_content",
        startedAt: "now",
      },
      { type: "reasoning", phase: "delta", reasoningId: "r1", text: "hmm" },
      { type: "reasoning", phase: "end", reasoningId: "r1", endedAt: "later", durationMs: 400 },
      { type: "delta", text: "Final." },
    ]

    const changed = events.map((event) => projector.apply(event))
    projector.finishStreaming()

    // The tool end without a diff and unknown event types leave the transcript untouched.
    expect(changed).toEqual([true, true, true, false, true, true, true, true, true])
    expect(
      transcript.entries.map((entry) => ({
        kind: entry.kind,
        text: entry.text,
        streaming: entry.streaming,
      })),
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

    expect(transcript.entries.map((entry) => entry.artifactDisplay)).toEqual([
      "superseded",
      "pending",
    ])
    projector.finishTurn()
    expect(transcript.entries.map((entry) => entry.artifactDisplay)).toEqual([
      "superseded",
      "ready",
    ])
  })

  it("ignores events that do not belong to the transcript", () => {
    const transcript = new TranscriptStore()
    const projector = new TranscriptProjector(transcript)

    expect(projector.apply({ type: "model", phase: "start" })).toBe(false)
    expect(
      projector.apply({ type: "context", messageCount: 1, contentChars: 10, tokens: 1_000 }),
    ).toBe(false)
    expect(
      projector.apply({ type: "reasoning", phase: "delta", reasoningId: "unknown", text: "x" }),
    ).toBe(false)
    expect(projector.apply({ type: "complete", messages: [] })).toBe(false)
    expect(transcript.entries).toEqual([])
    expect(projector.ensureAssistantEntry()).toMatchObject({
      kind: "message",
      speaker: "Otis",
      text: "",
    })
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
      projector.apply({
        ...tool,
        phase: "end",
        outcome: "completed",
        artifact: { ...artifact, version },
      })
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
    expect(
      transcript.entries.filter((entry) => entry.artifact).map((entry) => entry.artifactDisplay),
    ).toEqual(["superseded", "pending"])
    projector.finishTurn()
    expect(
      transcript.entries
        .filter((entry) => entry.artifactDisplay === "ready")
        .map((entry) => entry.artifact),
    ).toEqual([{ ...artifact, version: 2 }])
  })
})
