import { describe, expect, it, vi } from "vitest"
import { executeTurn } from "../../src/cli/turn-runner.js"
import type { AgentEvent } from "../../src/core/agent.js"
import type { ChatMessage } from "../../src/inference/types.js"

const mocks = vi.hoisted(() => ({ runAgent: vi.fn() }))
vi.mock("../../src/core/agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/core/agent.js")>()),
  runAgent: mocks.runAgent,
}))

const childMessages: ChatMessage[] = [
  { role: "user", content: "Map the repo." },
  { role: "assistant", content: [{ type: "text", text: "Report." }] },
]

function toolEvent(
  phase: "start" | "end",
  toolCallId: string,
  label: string,
  extra: Partial<Extract<AgentEvent, { type: "tool" }>> = {},
): AgentEvent {
  return { type: "tool", phase, toolCallId, name: "read", activityKind: "file_read", label, ...extra }
}

function child(toolCallId: string, event: AgentEvent): AgentEvent {
  return { type: "subagent", toolCallId, title: "Map", event }
}

describe("executeTurn", () => {
  it("records the turn's tool cards and each delegated run's trace for persistence", async () => {
    const script: AgentEvent[] = [
      toolEvent("start", "call_agent", "Delegating: Map", { name: "agent", activityKind: "agent" }),
      child("call_agent", { type: "model", phase: "start" }),
      child("call_agent", toolEvent("start", "read_1", "Reading files: a.ts")),
      child("call_agent", toolEvent("end", "read_1", "Reading files: a.ts", { outcome: "completed" })),
      child("call_agent", { type: "delta", text: "Report." }),
      child("call_agent", { type: "complete", messages: childMessages }),
      toolEvent("end", "call_agent", "Delegating: Map", { name: "agent", activityKind: "agent" }),
      toolEvent("start", "call_edit", "Editing file: b.ts", { name: "edit", activityKind: "file_edit" }),
      toolEvent("end", "call_edit", "Editing file: b.ts", {
        name: "edit",
        activityKind: "file_edit",
        diff: "--- b.ts\n+++ b.ts\n-old\n+new",
        outcome: "completed",
      }),
      { type: "complete", messages: [] },
    ]
    mocks.runAgent.mockImplementation(async function* () {
      yield* script
    })
    const observed: AgentEvent[] = []

    const result = await executeTurn({
      input: { role: "user", content: "go" },
      agent: { client: { model: "test", streamChat: vi.fn(), complete: vi.fn() } },
      onEvent: (event) => {
        observed.push(event)
      },
    })

    expect(result).toEqual({
      status: "complete",
      messages: [],
      details: {
        toolActivities: [
          { toolCallId: "call_agent", activityKind: "agent", label: "Delegating: Map" },
          {
            toolCallId: "call_edit",
            activityKind: "file_edit",
            label: "Editing file: b.ts",
            diff: "--- b.ts\n+++ b.ts\n-old\n+new",
          },
        ],
        subagents: [
          {
            toolCallId: "call_agent",
            title: "Map",
            status: "complete",
            messages: childMessages,
            toolActivities: [{ toolCallId: "read_1", activityKind: "file_read", label: "Reading files: a.ts" }],
            durationMs: expect.any(Number),
          },
        ],
      },
    })
    expect(observed).toEqual(script)
  })

  it("persists runs that were interrupted, failed, or never reported with a terminal status", async () => {
    mocks.runAgent.mockImplementation(async function* () {
      yield child("call_a", { type: "interrupted", messages: childMessages })
      yield child("call_b", { type: "error", message: "boom" })
      yield child("call_c", { type: "delta", text: "still going" })
      yield { type: "interrupted", messages: [] }
    })

    const result = await executeTurn({
      input: { role: "user", content: "go" },
      agent: { client: { model: "test", streamChat: vi.fn(), complete: vi.fn() } },
    })

    expect(result.status).toBe("interrupted")
    expect(result.details.subagents).toMatchObject([
      { toolCallId: "call_a", status: "interrupted", messages: childMessages },
      { toolCallId: "call_b", status: "failed", messages: [] },
      { toolCallId: "call_c", status: "failed", messages: [] },
    ])
    expect(result.details.subagents?.[2]).not.toHaveProperty("durationMs")
  })
})
