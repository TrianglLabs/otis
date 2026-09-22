import { afterEach, describe, expect, it, vi } from "vitest"
import {
  autoCompactThreshold,
  compactConversation,
  compactionSummaryMessage,
  isCompactionSummary,
} from "../../src/core/compaction.js"
import type { FireworksClient } from "../../src/inference/client.js"
import type { ChatMessage, StreamChatOptions } from "../../src/inference/types.js"
import { summaryFixture } from "../support/compaction.js"

const streamAgentMock = vi.hoisted(() => vi.fn())
const client = {
  model: "accounts/fireworks/models/test",
  streamChat: streamAgentMock,
} as unknown as FireworksClient

describe("autoCompactThreshold", () => {
  it("reserves model context and retains the default cap for large models", () => {
    expect(autoCompactThreshold(32_000)).toBe(25_600)
    expect(autoCompactThreshold(131_072)).toBe(104_857)
    expect(autoCompactThreshold(1_000_000)).toBe(250_000)
    expect(() => autoCompactThreshold(0)).toThrow("context length is invalid")
  })

  it("budgets an unknown hosted window like a 128K model instead of the cap", () => {
    expect(autoCompactThreshold()).toBe(autoCompactThreshold(131_072))
    expect(autoCompactThreshold()).toBe(104_857)
  })

  it("reserves the larger of the expected output and 20% of the window", () => {
    expect(autoCompactThreshold(65_536, 16_384)).toBe(49_152)
    expect(autoCompactThreshold(65_536, 8_192)).toBe(52_428)
    expect(autoCompactThreshold(131_072, 16_384)).toBe(104_857)
    expect(autoCompactThreshold(131_072, 8_192)).toBe(104_857)
  })
})

describe("compaction summary messages", () => {
  it("marks summaries", () => {
    const message = compactionSummaryMessage("## Goal\nDo the thing")

    expect(message).toEqual({
      role: "user",
      content: "[Compacted conversation summary]\n\n## Goal\nDo the thing",
    })
    expect(isCompactionSummary(message)).toBe(true)
    expect(isCompactionSummary({ role: "user", content: "hello" })).toBe(false)
    expect(
      isCompactionSummary({ role: "assistant", content: [{ type: "text", text: "hi" }] }),
    ).toBe(false)
  })
})

describe("compactConversation", () => {
  afterEach(() => streamAgentMock.mockReset())

  it("omits malformed arguments and parser snippets from summaries without changing saved messages", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Write the document" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            toolCall: {
              id: "bad",
              name: "write",
              arguments: `{"content":"${"private partial content".repeat(500)}`,
            },
          },
        ],
      },
      { role: "tool", toolCallId: "bad", content: "Parser error: private partial content" },
      { role: "user", content: "Continue" },
    ]
    const original = structuredClone(messages)
    streamAgentMock.mockImplementationOnce(async function* (request: StreamChatOptions) {
      expect(JSON.stringify(request.messages)).not.toContain("private partial content")
      expect(JSON.stringify(request.messages)).toContain(
        "arguments were not a complete JSON object",
      )
      yield {
        type: "text_delta",
        text: summaryFixture("Retry the failed write using smaller steps."),
      }
    })
    await compactConversation(messages, { client, keepRecentTokens: 10 })
    expect(streamAgentMock).toHaveBeenCalledOnce()
    expect(messages).toEqual(original)
  })

  it("refuses to summarize an unanswered prompt", async () => {
    await expect(
      compactConversation([{ role: "user", content: "hi" }], { client }),
    ).rejects.toThrow("Not enough conversation history to compact.")
    expect(streamAgentMock).not.toHaveBeenCalled()
  })

  it("compacts a single turn without separating a tool call from its result", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "do something" },
      {
        role: "assistant",
        content: [{ type: "tool_call", toolCall: { id: "call_1", name: "read", arguments: "{}" } }],
      },
      { role: "tool", toolCallId: "call_1", content: "result".repeat(100) },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ]
    streamAgentMock.mockImplementationOnce(async function* () {
      yield { type: "text_delta", text: summaryFixture("Work summarized.") }
    })
    const result = await compactConversation(messages, { client, keepRecentTokens: 10 })
    expect(result.keptMessages).toEqual([messages[3]])
  })

  it("compacts past a tool call that never received a result", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "first question" },
      {
        role: "assistant",
        content: [{ type: "tool_call", toolCall: { id: "lost", name: "read", arguments: "{}" } }],
      },
      { role: "user", content: "second question" },
      { role: "assistant", content: [{ type: "text", text: "second answer ".repeat(40) }] },
      { role: "user", content: "third question" },
      { role: "assistant", content: [{ type: "text", text: "third answer" }] },
    ]
    streamAgentMock.mockImplementationOnce(async function* () {
      yield { type: "text_delta", text: summaryFixture("Keep going") }
    })
    const result = await compactConversation(messages, { client, keepRecentTokens: 32 })
    expect(result.keptMessages).toEqual(messages.slice(4))
  })

  it.each([
    "## Goal:",
    "## Goals",
    "# Goal",
    "### Goal",
    "## GOAL",
  ])("accepts the required heading written as %s", async (heading) => {
    const messages: ChatMessage[] = [
      { role: "user", content: "first question" },
      { role: "assistant", content: [{ type: "text", text: "first answer".repeat(20) }] },
      { role: "user", content: "second question" },
      { role: "assistant", content: [{ type: "text", text: "second answer" }] },
    ]
    streamAgentMock.mockImplementationOnce(async function* () {
      yield {
        type: "text_delta",
        text: `${heading}\nShip it.\n\n## Progress\n### Done\n- [x] Read the code\n\n## Next Steps\n1. Write tests`,
      }
    })
    await expect(
      compactConversation(messages, { client, keepRecentTokens: 32 }),
    ).resolves.toMatchObject({ summary: expect.stringContaining("Ship it.") })
  })

  it("rejects a required section whose body is empty", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "first question" },
      { role: "assistant", content: [{ type: "text", text: "first answer".repeat(20) }] },
      { role: "user", content: "second question" },
      { role: "assistant", content: [{ type: "text", text: "second answer" }] },
    ]
    streamAgentMock.mockImplementationOnce(async function* () {
      yield { type: "text_delta", text: "## Goal\n\n## Progress\nDone.\n\n## Next Steps\nNone." }
    })
    await expect(compactConversation(messages, { client, keepRecentTokens: 32 })).rejects.toThrow(
      "omitted required summary sections",
    )
  })

  it("summarizes older messages and keeps the last turn", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "first question" },
      { role: "assistant", content: [{ type: "text", text: "first answer".repeat(20) }] },
      { role: "user", content: "second question" },
      { role: "assistant", content: [{ type: "text", text: "second answer" }] },
    ]

    streamAgentMock.mockImplementationOnce(async function* () {
      yield { type: "text_delta", text: summaryFixture("Do stuff") }
    })

    const result = await compactConversation(messages, { client, keepRecentTokens: 32 })

    expect(result.summary).toBe(summaryFixture("Do stuff"))
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
          {
            type: "image",
            data: "c2VjcmV0",
            mimeType: "image/png",
            name: "screen.png",
            sizeBytes: 6,
          },
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
      yield { type: "text_delta", text: summaryFixture("Summary") }
    })

    await compactConversation(messages, { client, keepRecentTokens: 32 })

    expect(capturedPrompt).toContain("[Image: screen.png (image/png, 6 bytes)]")
    expect(capturedPrompt).not.toContain("c2VjcmV0")
  })

  it("summarizes extracted document text without copying original document bytes", async () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "document",
            kind: "text",
            data: "c2VjcmV0LWZpbGU=",
            extractedText: "Important document contents",
            mimeType: "text/plain",
            name: "notes.txt",
            sizeBytes: 11,
            sha256: "0".repeat(64),
            truncated: false,
          },
          { type: "text", text: "Review this" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "Reviewed." }] },
      { role: "user", content: "Continue" },
      { role: "assistant", content: [{ type: "text", text: "Continuing." }] },
    ]
    let capturedPrompt = ""
    streamAgentMock.mockImplementationOnce(async function* (request: { messages: ChatMessage[] }) {
      capturedPrompt = request.messages[0].content as string
      yield { type: "text_delta", text: summaryFixture("Summary") }
    })

    await compactConversation(messages, { client, keepRecentTokens: 32 })

    expect(capturedPrompt).toContain("Important document contents")
    expect(capturedPrompt).toContain('"name":"notes.txt"')
    expect(capturedPrompt).not.toContain("c2VjcmV0LWZpbGU=")
    expect(capturedPrompt).toContain(`"sha256":"${"0".repeat(64)}"`)
  })

  it("cuts at a turn boundary, never splitting tool calls from results", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "read a file" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me read it." },
          {
            type: "tool_call",
            toolCall: { id: "call_1", name: "read", arguments: '{"path":"a.txt"}' },
          },
        ],
      },
      { role: "tool", toolCallId: "call_1", content: "read: a.txt\n\ncontents" },
      { role: "assistant", content: [{ type: "text", text: "Here's what I found." }] },
      { role: "user", content: "now edit it" },
      { role: "assistant", content: [{ type: "text", text: "Done editing." }] },
    ]

    streamAgentMock.mockImplementationOnce(async function* () {
      yield { type: "text_delta", text: summaryFixture("Summary of first turn") }
    })

    const result = await compactConversation(messages, { client, keepRecentTokens: 32 })

    expect(result.keptMessages).toEqual([
      { role: "user", content: "now edit it" },
      { role: "assistant", content: [{ type: "text", text: "Done editing." }] },
    ])
    expect(result.keptMessages.some((m) => m.role === "tool")).toBe(false)
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

    await expect(compactConversation(messages, { client, keepRecentTokens: 32 })).rejects.toThrow(
      "empty summary",
    )
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
      yield { type: "text_delta", text: summaryFixture("Summary of turns one and two") }
    })

    const result = await compactConversation(messages, { client, keepRecentTokens: 100_000 })

    expect(result.keptMessages).toEqual([
      { role: "user", content: "turn three" },
      { role: "assistant", content: [{ type: "text", text: "reply three" }] },
    ])
  })
})
