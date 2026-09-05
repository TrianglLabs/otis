import { afterEach, describe, expect, it, vi } from "vitest"
import {
  autoCompactThreshold,
  COMPACTION_SUMMARY_PREFIX,
  compactConversation,
  compactionSummaryMessage,
  extractCompactionSummary,
  isCompactionSummary,
} from "../../src/core/compaction.js"
import type { FireworksClient } from "../../src/inference/client.js"
import type { ChatMessage } from "../../src/inference/types.js"

const streamAgentMock = vi.hoisted(() => vi.fn())
const client = { model: "accounts/fireworks/models/test", streamChat: streamAgentMock } as unknown as FireworksClient

describe("autoCompactThreshold", () => {
  it("reserves model context and retains the default cap for large or unknown models", () => {
    expect(autoCompactThreshold(32_000)).toBe(25_600)
    expect(autoCompactThreshold(131_072)).toBe(104_857)
    expect(autoCompactThreshold(1_000_000)).toBe(250_000)
    expect(autoCompactThreshold()).toBe(250_000)
    expect(() => autoCompactThreshold(0)).toThrow("context length is invalid")
  })
})

describe("compaction summary messages", () => {
  it("marks and extracts summaries", () => {
    const message = compactionSummaryMessage("## Goal\nDo the thing")

    expect(message).toEqual({
      role: "user",
      content: `${COMPACTION_SUMMARY_PREFIX}\n\n## Goal\nDo the thing`,
    })
    expect(isCompactionSummary(message)).toBe(true)
    expect(extractCompactionSummary(message)).toBe("## Goal\nDo the thing")
    expect(isCompactionSummary({ role: "user", content: "hello" })).toBe(false)
    expect(isCompactionSummary({ role: "assistant", content: [{ type: "text", text: "hi" }] })).toBe(false)
  })

  it("leaves regular user content unchanged", () => {
    const message: ChatMessage = { role: "user", content: "no prefix here" }
    expect(extractCompactionSummary(message)).toBe("no prefix here")
  })
})

describe("compactConversation", () => {
  afterEach(() => streamAgentMock.mockReset())

  it("refuses to summarize an unanswered prompt", async () => {
    await expect(compactConversation([{ role: "user", content: "hi" }], { client })).rejects.toThrow(
      "Not enough conversation history to compact.",
    )
    expect(streamAgentMock).not.toHaveBeenCalled()
  })

  it("compacts a single turn without separating a tool call from its result", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "do something" },
      {
        role: "assistant",
        content: [{ type: "tool_call", toolCall: { id: "call_1", name: "read", arguments: "{}" } }],
      },
      { role: "tool", toolCallId: "call_1", content: "result" },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ]
    streamAgentMock.mockImplementationOnce(async function* () {
      yield { type: "text_delta", text: "Work summarized." }
    })
    const result = await compactConversation(messages, { client, keepRecentTokens: 10 })
    expect(result.keptMessages).toEqual([messages[3]])
  })

  it("summarizes older messages and keeps the last turn", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "first question" },
      { role: "assistant", content: [{ type: "text", text: "first answer".repeat(20) }] },
      { role: "user", content: "second question" },
      { role: "assistant", content: [{ type: "text", text: "second answer" }] },
    ]

    streamAgentMock.mockImplementationOnce(async function* () {
      yield { type: "text_delta", text: "## Goal\nDo stuff" }
    })

    const result = await compactConversation(messages, { client, keepRecentTokens: 32 })

    expect(result.summary).toBe("## Goal\nDo stuff")
    expect(result.keptMessages).toEqual([
      { role: "user", content: "second question" },
      { role: "assistant", content: [{ type: "text", text: "second answer" }] },
    ])
  })

  it("describes images in summary prompts without copying their base64 payload", async () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "image", data: "c2VjcmV0", mimeType: "image/png", name: "screen.png", sizeBytes: 6 },
          { type: "text", text: "Inspect this" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "I inspected it." }] },
      { role: "user", content: "Continue" },
      { role: "assistant", content: [{ type: "text", text: "Continuing." }] },
    ]
    let capturedPrompt = ""
    streamAgentMock.mockImplementationOnce(async function* (request: { messages: ChatMessage[] }) {
      capturedPrompt = request.messages[0].content as string
      yield { type: "text_delta", text: "Summary" }
    })

    await compactConversation(messages, { client, keepRecentTokens: 32 })

    expect(capturedPrompt).toContain("[Image: screen.png (image/png, 6 bytes)]")
    expect(capturedPrompt).not.toContain("c2VjcmV0")
  })

  it("cuts at a turn boundary, never splitting tool calls from results", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "read a file" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me read it." },
          { type: "tool_call", toolCall: { id: "call_1", name: "read", arguments: '{"path":"a.txt"}' } },
        ],
      },
      { role: "tool", toolCallId: "call_1", content: "read: a.txt\n\ncontents" },
      { role: "assistant", content: [{ type: "text", text: "Here's what I found." }] },
      { role: "user", content: "now edit it" },
      { role: "assistant", content: [{ type: "text", text: "Done editing." }] },
    ]

    streamAgentMock.mockImplementationOnce(async function* () {
      yield { type: "text_delta", text: "Summary of first turn" }
    })

    const result = await compactConversation(messages, { client, keepRecentTokens: 32 })

    expect(result.keptMessages).toEqual([
      { role: "user", content: "now edit it" },
      { role: "assistant", content: [{ type: "text", text: "Done editing." }] },
    ])
    expect(result.keptMessages.some((m) => m.role === "tool")).toBe(false)
  })

  it("passes custom instructions through to the summarization prompt", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "response".repeat(20) }] },
      { role: "user", content: "second" },
      { role: "assistant", content: [{ type: "text", text: "response".repeat(20) }] },
    ]

    let capturedPrompt = ""
    streamAgentMock.mockImplementationOnce(async function* (request: { messages: ChatMessage[] }) {
      capturedPrompt = request.messages[0].content as string
      yield { type: "text_delta", text: "Summary" }
    })

    await compactConversation(messages, {
      client,
      instructions: "Focus on the API design decisions",
      keepRecentTokens: 32,
    })

    expect(capturedPrompt).toContain("Focus on the API design decisions")
  })

  it("does not include custom instructions in the prompt when none are provided", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "response".repeat(20) }] },
      { role: "user", content: "second" },
      { role: "assistant", content: [{ type: "text", text: "response".repeat(20) }] },
    ]

    let capturedPrompt = ""
    streamAgentMock.mockImplementationOnce(async function* (request: { messages: ChatMessage[] }) {
      capturedPrompt = request.messages[0].content as string
      yield { type: "text_delta", text: "Summary" }
    })

    await compactConversation(messages, { client, keepRecentTokens: 32 })

    expect(capturedPrompt).not.toContain("Additional focus")
  })

  it("throws when the model returns an empty summary", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "response".repeat(20) }] },
      { role: "user", content: "second" },
      { role: "assistant", content: [{ type: "text", text: "response".repeat(20) }] },
    ]

    streamAgentMock.mockImplementationOnce(async function* () {
      yield* []
    })

    await expect(compactConversation(messages, { client, keepRecentTokens: 32 })).rejects.toThrow("empty summary")
  })

  it("keeps only the last turn when conversation fits within the keep budget", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "turn one" },
      { role: "assistant", content: [{ type: "text", text: "reply one".repeat(20) }] },
      { role: "user", content: "turn two" },
      { role: "assistant", content: [{ type: "text", text: "reply two" }] },
      { role: "user", content: "turn three" },
      { role: "assistant", content: [{ type: "text", text: "reply three" }] },
    ]

    streamAgentMock.mockImplementationOnce(async function* () {
      yield { type: "text_delta", text: "Summary of turns one and two" }
    })

    const result = await compactConversation(messages, { client, keepRecentTokens: 100_000 })

    expect(result.keptMessages).toEqual([
      { role: "user", content: "turn three" },
      { role: "assistant", content: [{ type: "text", text: "reply three" }] },
    ])
  })
})
