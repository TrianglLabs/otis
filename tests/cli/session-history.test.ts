import { describe, expect, it, vi } from "vitest"
import { prepareSessionHistory } from "../../src/cli/session-history.js"
import { COMPACTION_SUMMARY_PREFIX } from "../../src/core/compaction.js"
import type { FireworksClient } from "../../src/inference/client.js"
import type { JsonlSession } from "../../src/storage/index.js"

describe("prepareSessionHistory", () => {
  it("compacts persisted history before it exceeds the selected model context", async () => {
    const compact = vi.fn(async () => undefined)
    const recordUsage = vi.fn(async () => undefined)
    const session = {
      compact,
      replay: () => ({
        messages: [
          { role: "user" as const, content: "first question" },
          { role: "assistant" as const, content: [{ type: "text" as const, text: "first answer" }] },
          { role: "user" as const, content: "recent question" },
          { role: "assistant" as const, content: [{ type: "text" as const, text: "recent answer" }] },
        ],
        toolActivities: [],
        subagents: [],
      }),
    } as unknown as JsonlSession
    const client = {
      streamChat: async function* () {
        yield { type: "text_delta" as const, text: "Earlier work summary." }
        yield {
          type: "usage" as const,
          usage: { promptTokens: 10, completionTokens: 3, totalTokens: 13 },
        }
      },
    } as unknown as FireworksClient

    const history = await prepareSessionHistory({
      session,
      client,
      contextLength: 1,
      staticContextChars: 0,
      onUsage: recordUsage,
    })

    expect(compact).toHaveBeenCalledWith(
      "Earlier work summary.",
      [
        { role: "user", content: "recent question" },
        { role: "assistant", content: [{ type: "text", text: "recent answer" }] },
      ],
      { toolActivities: [], subagents: [] },
    )
    expect(history[0]).toMatchObject({ role: "user", content: expect.stringContaining(COMPACTION_SUMMARY_PREFIX) })
    expect(recordUsage).toHaveBeenCalledOnce()
  })

  it("keeps tool cards and subagent traces whose delegating call survives compaction", async () => {
    const compact = vi.fn(async () => undefined)
    const keptAgentCall = {
      type: "tool_call" as const,
      toolCall: { id: "call_recent", name: "agent", arguments: '{"description":"Map","prompt":"List."}' },
    }
    const run = (toolCallId: string) => ({
      toolCallId,
      title: "Map",
      status: "complete" as const,
      messages: [{ role: "assistant" as const, content: [{ type: "text" as const, text: "Report." }] }],
    })
    const session = {
      compact,
      replay: () => ({
        messages: [
          { role: "user" as const, content: "first question" },
          { role: "assistant" as const, content: [{ type: "text" as const, text: "first answer" }] },
          { role: "user" as const, content: "recent question" },
          { role: "assistant" as const, content: [keptAgentCall] },
          { role: "tool" as const, toolCallId: "call_recent", content: "agent: Map\n\nReport." },
          { role: "assistant" as const, content: [{ type: "text" as const, text: "recent answer" }] },
        ],
        toolActivities: [
          { toolCallId: "call_old", activityKind: "agent" as const, label: "Delegating: Old" },
          { toolCallId: "call_recent", activityKind: "agent" as const, label: "Delegating: Map" },
        ],
        subagents: [run("call_old"), run("call_recent")],
      }),
    } as unknown as JsonlSession
    const client = {
      streamChat: async function* () {
        yield { type: "text_delta" as const, text: "Summary." }
      },
    } as unknown as FireworksClient

    await prepareSessionHistory({ session, client, contextLength: 1, staticContextChars: 0 })

    expect(compact).toHaveBeenCalledWith("Summary.", expect.any(Array), {
      toolActivities: [{ toolCallId: "call_recent", activityKind: "agent", label: "Delegating: Map" }],
      subagents: [run("call_recent")],
    })
  })
})
