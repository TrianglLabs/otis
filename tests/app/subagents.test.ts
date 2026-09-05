import { describe, expect, it } from "vitest"
import { SubagentTraces } from "../../src/app/subagents.js"
import { TurnDetailsRecorder } from "../../src/app/turn-details.js"
import type { AgentEvent } from "../../src/core/agent.js"
import { compactionSummaryMessage } from "../../src/core/compaction.js"
import type { ChatMessage } from "../../src/inference/types.js"

const childMessages: ChatMessage[] = [
  { role: "user", content: "Map the repo." },
  {
    role: "assistant",
    content: [{ type: "tool_call", toolCall: { id: "read_1", name: "read", arguments: '{"path":"a.ts"}' } }],
  },
  { role: "tool", toolCallId: "read_1", content: "a" },
  { role: "assistant", content: [{ type: "text", text: "Report." }] },
]

const parentMessages: ChatMessage[] = [
  { role: "user", content: "map" },
  {
    role: "assistant",
    content: [
      { type: "tool_call", toolCall: { id: "call_a", name: "agent", arguments: '{"description":"A","prompt":"a"}' } },
      { type: "tool_call", toolCall: { id: "call_b", name: "agent", arguments: '{"description":"B","prompt":"b"}' } },
    ],
  },
]

function envelope(toolCallId: string, event: AgentEvent): Extract<AgentEvent, { type: "subagent" }> {
  return { type: "subagent", toolCallId, title: `Task ${toolCallId}`, event }
}

describe("SubagentTraces", () => {
  it("keeps child checkpoints and continuation messages consistent between the live trace and saved run", () => {
    const traces = new SubagentTraces()
    const recorder = new TurnDetailsRecorder()
    const events: AgentEvent[] = [
      {
        type: "tool",
        phase: "start",
        toolCallId: "old_read",
        name: "read",
        activityKind: "file_read",
        label: "Reading old file",
      },
      { type: "compaction", phase: "complete", summary: "Earlier exploration.", keptMessages: [] },
      {
        type: "tool",
        phase: "start",
        toolCallId: "read_1",
        name: "read",
        activityKind: "file_read",
        label: "Reading a.ts",
      },
      { type: "delta", text: "Report." },
      { type: "complete", messages: childMessages },
    ]
    for (const event of events) {
      const wrapped = envelope("call_a", event)
      traces.apply(wrapped)
      recorder.record(wrapped)
    }
    const saved = recorder.subagents[0]
    expect(saved.messages).toEqual([compactionSummaryMessage("Earlier exploration."), ...childMessages])
    expect(traces.get("call_a")?.transcript.history).toEqual(saved.messages)
    expect(saved.toolActivities?.map((activity) => activity.toolCallId)).toEqual(["read_1"])
    expect(traces.runsFor(parentMessages)[0].toolActivities).toEqual(saved.toolActivities)
  })

  it("builds a live transcript per run and settles its status from the child's terminal event", () => {
    const traces = new SubagentTraces()

    traces.apply(envelope("call_a", { type: "model", phase: "start" }))
    traces.apply(envelope("call_b", { type: "model", phase: "start" }))
    traces.apply(
      envelope("call_a", {
        type: "tool",
        phase: "start",
        toolCallId: "read_1",
        name: "read",
        activityKind: "file_read",
        label: "Reading files: a.ts",
      }),
    )
    traces.apply(envelope("call_a", { type: "delta", text: "Report." }))
    expect(traces.all.map((trace) => [trace.toolCallId, trace.title, trace.status])).toEqual([
      ["call_a", "Task call_a", "running"],
      ["call_b", "Task call_b", "running"],
    ])
    expect(traces.get("call_a")?.transcript.entries.map((entry) => entry.text)).toEqual([
      "Reading files: a.ts",
      "Report.",
    ])
    expect(traces.get("call_a")?.transcript.entries[1].streaming).toBe(true)
    const running = traces.get("call_a")

    const completed = traces.apply(envelope("call_a", { type: "complete", messages: childMessages }))
    traces.apply(envelope("call_b", { type: "error", message: "boom" }))

    expect(completed).toMatchObject({ status: "complete", durationMs: expect.any(Number) })
    expect(completed.transcript.entries[1].streaming).toBe(false)
    expect(completed.transcript.history).toEqual(childMessages)
    expect(traces.get("call_b")).toMatchObject({ status: "failed" })
    // Status changes produce a new trace object, so a view holding the old one can detect the change.
    expect(running?.status).toBe("running")
    expect(traces.get("call_a")).not.toBe(running)
    expect(traces.get("call_a")?.transcript).toBe(running?.transcript)
  })

  it("loads saved runs and converts finished traces back into the persisted shape for compaction", () => {
    const traces = new SubagentTraces()
    traces.apply(envelope("call_a", { type: "delta", text: "working" }))
    traces.load([
      {
        toolCallId: "call_b",
        title: "B",
        status: "complete",
        messages: childMessages,
        toolActivities: [{ toolCallId: "read_1", activityKind: "file_read", label: "Reading files: a.ts" }],
        durationMs: 900,
      },
    ])

    expect(traces.all).toHaveLength(1)
    expect(traces.get("call_a")).toBeUndefined()
    expect(traces.get("call_b")?.transcript.entries.map((entry) => entry.text)).toEqual([
      "Map the repo.",
      "Reading files: a.ts",
      "Report.",
    ])

    traces.apply(envelope("call_a", { type: "delta", text: "still running" }))
    traces.apply(envelope("call_c", { type: "interrupted", messages: [] }))

    // Running runs are not persisted, and runs whose delegating call was compacted away are dropped.
    expect(traces.runsFor(parentMessages)).toEqual([
      {
        toolCallId: "call_b",
        title: "B",
        status: "complete",
        messages: childMessages,
        toolActivities: [{ toolCallId: "read_1", activityKind: "file_read", label: "Reading files: a.ts" }],
        durationMs: 900,
      },
    ])
  })
})
