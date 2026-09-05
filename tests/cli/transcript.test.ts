import { describe, expect, it } from "vitest"
import { TranscriptStore } from "../../src/cli/transcript.js"

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

  it("reconstructs tool cards from older sessions without activity metadata", () => {
    const transcript = new TranscriptStore()
    const messages = [
      { role: "user" as const, content: "hello" },
      {
        role: "assistant" as const,
        content: [
          { type: "text" as const, text: "I'll check." },
          { type: "tool_call" as const, toolCall: { id: "call_1", name: "read", arguments: '{"path":"a.txt"}' } },
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
          { type: "tool_call", toolCall: { id: "call_1", name: "read", arguments: '{"path":"a.txt"}' } },
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
            toolCall: { id: "call_1", name: "edit", arguments: '{"path":"one.ts","old":"a","new":"b"}' },
          },
          {
            type: "tool_call" as const,
            toolCall: { id: "call_2", name: "edit", arguments: '{"path":"two.ts","old":"a","new":"b"}' },
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

    expect(transcript.entries.map((entry) => ({ text: entry.text, toolCallId: entry.toolCallId }))).toEqual([
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

  it("replaces history and transcript with compaction summary + kept messages", () => {
    const transcript = new TranscriptStore()

    transcript.loadMessages([
      { role: "user", content: "old question" },
      { role: "assistant", content: [{ type: "text", text: "old answer" }] },
    ])

    const keptMessages = [
      { role: "user" as const, content: "recent question" },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "recent answer" }] },
    ]

    transcript.loadCompacted("## Goal\nDo the thing", keptMessages)

    expect(transcript.history).toEqual([
      { role: "user", content: "[Compacted conversation summary]\n\n## Goal\nDo the thing" },
      { role: "user", content: "recent question" },
      { role: "assistant", content: [{ type: "text", text: "recent answer" }] },
    ])

    expect(transcript.entries).toEqual([
      {
        id: 3,
        kind: "message",
        speaker: "Otis",
        text: "**Conversation compacted.** Older messages were summarized to free context.\n\n## Goal\nDo the thing",
      },
      { id: 4, kind: "message", speaker: "You", text: "recent question" },
      { id: 5, kind: "message", speaker: "Otis", text: "recent answer" },
    ])
  })

  it("preserves pending prompt identities when a compaction replaces rendered history", () => {
    const transcript = new TranscriptStore()
    transcript.loadMessages([{ role: "user", content: "old task" }])
    const queued = transcript.addQueuedUserMessage("queued task")
    const steering = transcript.addSteeringUserMessage("new direction")
    transcript.loadCompacted("Summary.", [{ role: "assistant", content: [{ type: "text", text: "Kept." }] }])
    expect(new Set(transcript.entries.map((entry) => entry.id)).size).toBe(transcript.entries.length)
    expect(transcript.activatePendingUserMessage(queued.id)).toBe(true)
    expect(transcript.activatePendingUserMessage(steering.id)).toBe(true)
    expect(transcript.entries.slice(-2).map((entry) => entry.text)).toEqual(["queued task", "new direction"])
    expect(transcript.entries.some((entry) => entry.delivery)).toBe(false)
  })

  it("renders compaction summary as an Otis message when reloading a compacted session", () => {
    const transcript = new TranscriptStore()
    const messages = [
      { role: "user" as const, content: "[Compacted conversation summary]\n\n## Goal\nDo the thing" },
      { role: "user" as const, content: "recent question" },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "recent answer" }] },
    ]

    transcript.loadMessages(messages)

    expect(transcript.history).toEqual(messages)
    expect(transcript.entries).toEqual([
      {
        id: 1,
        kind: "message",
        speaker: "Otis",
        text: "**Conversation compacted.** Older messages were summarized to free context.\n\n## Goal\nDo the thing",
      },
      { id: 2, kind: "message", speaker: "You", text: "recent question" },
      { id: 3, kind: "message", speaker: "Otis", text: "recent answer" },
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
          toolCall: { id: "call_0", name: "edit", arguments: `{"path":"${path}","old":"a","new":"b"}` },
        },
      ],
    },
    { role: "tool" as const, toolCallId: "call_0", content: "updated" },
  ]
}
