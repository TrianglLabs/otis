import { describe, expect, it } from "vitest"
import { compactionSummaryMessage } from "../../src/core/compaction.js"
import {
  hasObjectArguments,
  openaiChatCompletionRequest,
  toolCallHistoryForRequest,
} from "../../src/inference/openai-compat.js"
import type { ChatMessage } from "../../src/inference/types.js"

const INVALID_TOOL_ARGUMENTS_RESULT = expect.stringContaining(
  "arguments were not a complete JSON object",
)

function call(argumentsJSON: string, id = "call_1"): ChatMessage {
  return {
    role: "assistant",
    content: [
      { type: "reasoning", field: "reasoning_content", text: "Original reasoning" },
      { type: "tool_call", toolCall: { id, name: "write", arguments: argumentsJSON } },
    ],
  }
}

describe("tool-call request history", () => {
  it.each([
    "",
    " ",
    '{"content":"unfinished',
    "null",
    "[]",
    "42",
    '"text"',
  ])("projects invalid object arguments safely: %s", (argumentsJSON) => {
    const messages: ChatMessage[] = [
      call(argumentsJSON),
      {
        role: "tool",
        toolCallId: "call_1",
        content: "Parser error containing private partial file content",
      },
      { role: "user", content: "try again" },
    ]
    const original = structuredClone(messages)
    const wire = openaiChatCompletionRequest("test", { messages })
    expect(hasObjectArguments(argumentsJSON)).toBe(false)
    expect(wire.messages[1]).toMatchObject({
      role: "assistant",
      reasoning_content: "Original reasoning",
      tool_calls: [{ id: "call_1", function: { name: "write", arguments: "{}" } }],
    })
    expect(wire.messages[2]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: INVALID_TOOL_ARGUMENTS_RESULT,
    })
    expect(wire.messages).toHaveLength(4)
    expect(JSON.stringify(wire)).not.toContain("private partial file content")
    expect(messages).toEqual(original)
  })

  it("leaves valid reasoning, arguments, results, and message order unchanged", () => {
    const messages: ChatMessage[] = [
      call(' { "path": "note.txt", "content": "hello" } '),
      { role: "tool", toolCallId: "call_1", content: "Written." },
    ]
    const projected = toolCallHistoryForRequest(messages)
    expect(projected).toEqual(messages)
    expect(projected[0]).toBe(messages[0])
    expect(projected[1]).toBe(messages[1])
  })

  it("supplies missing failure results before the next user message, not orphaning others", () => {
    const first = call("broken")
    if (first.role !== "assistant") throw new Error("Expected assistant fixture")
    first.content.push({
      type: "tool_call",
      toolCall: { id: "valid", name: "read", arguments: '{"path":"note.txt"}' },
    })
    const validResult: ChatMessage = {
      role: "tool",
      toolCallId: "valid",
      content: "Existing result",
    }
    const user: ChatMessage = { role: "user", content: "Continue" }
    const projected = toolCallHistoryForRequest([first, validResult, user])
    expect(projected.slice(1)).toEqual([
      validResult,
      { role: "tool", toolCallId: "call_1", content: INVALID_TOOL_ARGUMENTS_RESULT },
      user,
    ])
    expect(toolCallHistoryForRequest(projected)).toEqual(projected)
  })

  it("scopes repair to each assistant batch, including reused call IDs", () => {
    const validResult: ChatMessage = {
      role: "tool",
      toolCallId: "call_1",
      content: "Successful later call",
    }
    const projected = toolCallHistoryForRequest([call("broken"), call("{}"), validResult])
    expect(projected).toHaveLength(4)
    expect(projected.at(-1)).toBe(validResult)
    expect(toolCallHistoryForRequest([call("broken")]).at(-1)).toEqual({
      role: "tool",
      toolCallId: "call_1",
      content: INVALID_TOOL_ARGUMENTS_RESULT,
    })
  })
})

describe("adjacent user messages", () => {
  it("serializes a compaction summary and the kept prompt as one user message", () => {
    const summary = compactionSummaryMessage("## Goal\nShip it")
    const messages: ChatMessage[] = [summary, { role: "user", content: "continue" }]
    const original = structuredClone(messages)
    const wire = openaiChatCompletionRequest("test", { messages })
    expect(wire.messages.slice(1)).toEqual([
      { role: "user", content: `${summary.content}\n\ncontinue` },
    ])
    expect(messages).toEqual(original)
  })

  it("merges drained steering after a reply, keeping attachments and text in order", () => {
    const image = {
      type: "image" as const,
      data: "aGk=",
      mimeType: "image/png" as const,
      name: "shot.png",
      sizeBytes: 2,
    }
    const messages: ChatMessage[] = [
      { role: "user", content: "start" },
      { role: "assistant", content: [{ type: "text", text: "Working." }] },
      { role: "user", content: [image, { type: "text", text: "look here" }] },
      { role: "user", content: "and then this" },
      { role: "user", content: [{ type: "text", text: "finally" }, image] },
    ]
    const wire = openaiChatCompletionRequest("test", { messages })
    expect(wire.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ])
    expect(wire.messages[3]).toEqual({
      role: "user",
      content: [
        { type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } },
        { type: "text", text: "look here\n\nand then this\n\nfinally" },
        { type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } },
      ],
    })
  })
})
