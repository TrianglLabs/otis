import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type AgentEvent, type RunAgentOptions, runAgent } from "../../src/core/agent.js"
import { autoCompactThreshold, isCompactionSummary } from "../../src/core/compaction.js"
import { FireworksClient } from "../../src/inference/client.js"
import { OpenAICompatibleClient } from "../../src/inference/openai-compat.js"
import type { ChatMessage, InferenceClient, TokenUsage } from "../../src/inference/types.js"
import { createPermissionPolicy } from "../../src/permissions/policy.js"
import { emptySkillCatalog } from "../../src/skills/index.js"
import { TOOL_DEFINITIONS } from "../../src/tools/index.js"
import { summaryFixture } from "../support/compaction.js"
import {
  delta,
  type FakeOpenAIServer,
  startFakeOpenAIServer,
  usageChunk,
} from "../support/openai-fake-server.js"

/**
 * Both hosted and local transports run end to end through the agent loop against a fake that
 * speaks the real wire format, so request serialization, stream parsing, overflow recovery, and
 * the idle watchdog are exercised together rather than per function.
 */
const transports = [
  {
    name: "FireworksClient",
    label: "Fireworks",
    bearer: "Bearer fw_test_key",
    create: (url: string, idleTimeoutMs: number): InferenceClient =>
      new FireworksClient({
        apiKey: "fw_test_key",
        model: "accounts/fireworks/models/kimi-k3",
        inferenceURL: url,
        idleTimeoutMs,
      }),
  },
  {
    name: "OpenAICompatibleClient",
    label: "Local model",
    bearer: "Bearer local-secret",
    create: (url: string, idleTimeoutMs: number): InferenceClient =>
      new OpenAICompatibleClient({
        model: "local-model",
        inferenceURL: url,
        modelLabel: "Local model",
        inferenceURLLabel: "Local inference URL",
        requestLabel: "Local model",
        apiKey: "local-secret",
        idleTimeoutMs,
      }),
  },
]

type WireMessage = {
  role: string
  content: string | null
  reasoning_content?: string
  tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

function wireMessages(server: FakeOpenAIServer, index: number) {
  return server.requests[index].body.messages as WireMessage[]
}

describe.each(transports)("$name against a wire-format fake", (transport) => {
  let server: FakeOpenAIServer
  let cwd: string

  beforeEach(async () => {
    server = await startFakeOpenAIServer()
    cwd = await mkdtemp(join(tmpdir(), "otis-provider-contract-"))
  })

  afterEach(async () => {
    await server.close()
    await rm(cwd, { recursive: true, force: true })
  })

  async function drive(
    client: InferenceClient,
    input: string,
    history: ChatMessage[] = [],
    extra: Partial<RunAgentOptions> = {},
  ) {
    const events: AgentEvent[] = []
    const usage: TokenUsage[] = []
    const compactionUsage: TokenUsage[] = []
    for await (const event of runAgent(input, history, {
      client,
      cwd,
      tools: TOOL_DEFINITIONS.filter((tool) => tool.name === "read"),
      permissionPolicy: createPermissionPolicy({ cwd, mode: "auto" }),
      projectContext: [],
      skills: emptySkillCatalog(),
      trustReportedContextLength: true,
      onUsage: (value) => {
        usage.push(value)
      },
      onCompactionUsage: (value) => {
        compactionUsage.push(value)
      },
      ...extra,
    })) {
      events.push(event)
    }
    return { events, usage, compactionUsage }
  }

  it("round-trips a tool call: reasoning and the call go back out, the result comes back in", async () => {
    await writeFile(join(cwd, "note.txt"), "hello from the note\n")
    server.replies.push(
      {
        kind: "sse",
        chunks: [
          delta({ reasoning_content: "Let me read the note." }),
          delta(
            {
              tool_calls: [
                {
                  index: 0,
                  id: "call_note",
                  function: { name: "read", arguments: '{"path":"note.txt"}' },
                },
              ],
            },
            "tool_calls",
          ),
          usageChunk(40, 12),
        ],
      },
      {
        kind: "sse",
        chunks: [
          delta({ content: "The note says " }),
          delta({ content: "hello." }, "stop"),
          usageChunk(80, 5),
        ],
      },
    )
    const client = transport.create(server.url, 5_000)
    const { events, usage } = await drive(client, "What does note.txt say?")

    const complete = events.find((event) => event.type === "complete")
    expect(complete?.type).toBe("complete")
    if (complete?.type !== "complete") return
    expect(complete.messages).toEqual([
      { role: "user", content: "What does note.txt say?" },
      {
        role: "assistant",
        content: [
          expect.objectContaining({
            type: "reasoning",
            field: "reasoning_content",
            text: "Let me read the note.",
          }),
          {
            type: "tool_call",
            toolCall: { id: "call_note", name: "read", arguments: '{"path":"note.txt"}' },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_note",
        content: expect.stringContaining("hello from the note"),
      },
      { role: "assistant", content: [{ type: "text", text: "The note says hello." }] },
    ])
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool", phase: "end", name: "read", outcome: "completed" }),
    )
    expect(usage).toEqual([
      { promptTokens: 40, completionTokens: 12, totalTokens: 52 },
      { promptTokens: 80, completionTokens: 5, totalTokens: 85 },
    ])

    expect(server.requests).toHaveLength(2)
    for (const request of server.requests) {
      expect(request.path).toBe("/v1/chat/completions")
      expect(request.headers.authorization).toBe(transport.bearer)
      expect(request.headers.accept).toBe("text/event-stream")
      expect(request.body).toMatchObject({
        stream: true,
        stream_options: { include_usage: true },
        tools: [{ type: "function", function: { name: "read" } }],
      })
    }
    // The second request carries the provider-native reasoning and the tool exchange verbatim.
    const second = wireMessages(server, 1)
    expect(second.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool"])
    expect(second[2]).toEqual({
      role: "assistant",
      content: null,
      reasoning_content: "Let me read the note.",
      tool_calls: [
        {
          id: "call_note",
          type: "function",
          function: { name: "read", arguments: '{"path":"note.txt"}' },
        },
      ],
    })
    expect(second[3]).toMatchObject({ role: "tool", tool_call_id: "call_note" })
    expect(second[3].content).toContain("hello from the note")
  })

  it("recovers from a context-overflow 400 by compacting history and retrying once", async () => {
    const paragraph = (topic: string) =>
      Array.from(
        { length: 120 },
        (_, index) => `${topic} step ${index + 1}: the team recorded the outcome and its owner.`,
      ).join(" ")
    const history: ChatMessage[] = [
      { role: "user", content: "Walk me through the deployment history." },
      { role: "assistant", content: [{ type: "text", text: paragraph("Deployment") }] },
      { role: "user", content: "And the rollback plan?" },
      { role: "assistant", content: [{ type: "text", text: paragraph("Rollback") }] },
    ]
    const summary = summaryFixture("Write the runbook summary.")
    server.replies.push(
      {
        kind: "status",
        status: 400,
        json: {
          error: {
            object: "error",
            type: "invalid_request_error",
            code: "context_length_exceeded",
            message:
              "This model's maximum context length is 131072 tokens. However, you requested 140000 tokens.",
          },
        },
      },
      { kind: "sse", chunks: [delta({ content: summary }, "stop"), usageChunk(900, 120)] },
      {
        kind: "sse",
        chunks: [
          delta({ content: "Runbook: deploy, verify, roll back." }, "stop"),
          usageChunk(300, 9),
        ],
      },
    )
    const client = transport.create(server.url, 5_000)
    const { events, usage, compactionUsage } = await drive(
      client,
      "Now write the runbook summary.",
      history,
      { autoCompactAtTokens: autoCompactThreshold(131_072) },
    )

    expect(events.map((event) => event.type)).toEqual([
      "context",
      "model",
      "compaction",
      "compaction",
      "context",
      "model",
      "delta",
      "context",
      "complete",
    ])
    expect(events[1]).toEqual({ type: "model", phase: "start" })
    expect(events[5]).toEqual({ type: "model", phase: "retry" })
    expect(events[3]).toMatchObject({
      type: "compaction",
      phase: "complete",
      summary,
      keptMessages: [{ role: "user", content: "Now write the runbook summary." }],
    })
    expect(events.at(-1)).toEqual({
      type: "complete",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Runbook: deploy, verify, roll back." }],
        },
      ],
    })
    expect(compactionUsage).toEqual([
      { promptTokens: 900, completionTokens: 120, totalTokens: 1020 },
    ])
    expect(usage).toEqual([{ promptTokens: 300, completionTokens: 9, totalTokens: 309 }])

    expect(server.requests).toHaveLength(3)
    expect(wireMessages(server, 0)).toHaveLength(6)
    const summaryRequest = wireMessages(server, 1)
    expect(summaryRequest.map((message) => message.role)).toEqual(["system", "user"])
    expect(summaryRequest[0].content).toContain("You are a conversation summarizer.")
    expect(summaryRequest[1].content).toContain("Conversation to summarize:")
    expect(summaryRequest[1].content).toContain("Deployment step 120")
    expect(summaryRequest[1].content).toContain("Rollback step 120")
    expect(server.requests[1].body.tools).toBeUndefined()
    // The retry sends the summary in place of the history, merged with the unanswered prompt.
    const retry = wireMessages(server, 2)
    expect(retry.map((message) => message.role)).toEqual(["system", "user"])
    const merged = retry[1].content ?? ""
    expect(isCompactionSummary({ role: "user", content: merged })).toBe(true)
    expect(merged).toContain(summary)
    expect(merged.endsWith("Now write the runbook summary.")).toBe(true)
    expect(merged).not.toContain("Deployment step 1:")
  })

  it("abandons a stalled stream after the idle timeout, keeping what it streamed", async () => {
    server.replies.push({ kind: "stall", chunks: [delta({ content: "Partial" })] })
    const client = transport.create(server.url, 250)
    const startedAt = Date.now()
    const { events } = await drive(client, "Keep going.")
    const elapsed = Date.now() - startedAt

    expect(events).toContainEqual({ type: "delta", text: "Partial" })
    expect(events.at(-1)).toEqual({
      type: "error",
      message: `${transport.label} sent no data for 250 ms; the request timed out.`,
      messages: [
        { role: "user", content: "Keep going." },
        { role: "assistant", content: [{ type: "text", text: "Partial" }] },
      ],
    })
    // The watchdog fires from the last chunk, not from the request start or a total deadline.
    expect(elapsed).toBeGreaterThanOrEqual(250)
    expect(elapsed).toBeLessThan(5_000)
    expect(server.requests).toHaveLength(1)
  })
})
