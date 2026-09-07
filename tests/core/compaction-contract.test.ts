import { describe, expect, it, vi } from "vitest"
import { compactConversation } from "../../src/core/compaction.js"
import { requestContextEstimator } from "../../src/core/context-tokens.js"
import { openaiChatCompletionRequest } from "../../src/inference/openai-compat.js"
import type { ChatMessage, ChatStreamEvent, InferenceClient, StreamChatOptions } from "../../src/inference/types.js"
import { summaryFixture } from "../support/compaction.js"

const history: ChatMessage[] = [
  { role: "user", content: "Build the Electron GUI." },
  { role: "assistant", content: [{ type: "text", text: "Earlier implementation details. ".repeat(1_000) }] },
  { role: "user", content: "Continue." },
]

function client(events: ChatStreamEvent[]): InferenceClient {
  return {
    model: "fake",
    complete: vi.fn(),
    streamChat: vi.fn(async function* () {
      yield* events
    }),
  }
}

describe("compaction request contract", () => {
  it("uses summarization system instructions instead of the working agent prompt for every chunk", async () => {
    const requests: StreamChatOptions[] = []
    const inference = client([])
    inference.streamChat = async function* (request) {
      requests.push(request)
      yield { type: "text_delta", text: summaryFixture() }
    }
    await compactConversation(history, {
      client: inference,
      maxInputTokens: 4_000,
      instructions: "Preserve UI decisions.",
    })

    expect(requests.length).toBeGreaterThan(1)
    for (const request of requests) {
      const body = openaiChatCompletionRequest("fake", request)
      expect(body.messages[0].content).toContain("You are a conversation summarizer")
      expect(body.messages[0].content).toContain("Preserve UI decisions.")
      expect(body.messages[0].content).not.toContain("Complete every task end to end")
      expect(body).not.toHaveProperty("tools")
      expect(requestContextEstimator(request)(request.messages)).toBeLessThanOrEqual(4_000)
    }
    expect(requests[1].messages[0].content).toContain(summaryFixture())
  })

  it.each([
    "The composer fragment did not match. Checking its actual state:\n[Tool call: bash({})]",
    "[Tool call: bash({})]\n\nTool result: SyntaxError\n\nDoing it with another command instead.",
    "## Goal\nFix the GUI\n\n## Progress\n\n## Next Steps\n",
  ])("rejects a non-summary response without replacing history: %s", async (text) => {
    const original = structuredClone(history)
    await expect(
      compactConversation(history, {
        client: client([
          { type: "text_delta", text },
          { type: "finish", reason: "stop" },
        ]),
      }),
    ).rejects.toThrow("required summary sections")
    expect(history).toEqual(original)
  })

  it("rejects tool calls even when accompanied by summary text and a stop finish", async () => {
    await expect(
      compactConversation(history, {
        client: client([
          { type: "text_delta", text: summaryFixture() },
          { type: "tool_call", toolCall: { id: "unexpected", name: "bash", arguments: "{}" } },
          { type: "finish", reason: "stop" },
        ]),
      }),
    ).rejects.toThrow("requested a tool")
  })
})
