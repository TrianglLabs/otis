import { describe, expect, it, vi } from "vitest"
import { type AgentEvent, runAgent } from "../../src/core/agent.js"
import { compactConversation, compactionSummaryMessage } from "../../src/core/compaction.js"
import { estimateMessageTokens, requestContextEstimator } from "../../src/core/context-tokens.js"
import { SteeringInbox } from "../../src/core/steering.js"
import { ContextOverflowError } from "../../src/inference/errors.js"
import type { ChatMessage, InferenceClient, StreamChatOptions } from "../../src/inference/types.js"
import { TOOL_DEFINITIONS } from "../../src/tools/index.js"
import { summaryFixture } from "../support/compaction.js"

const user = (content: string): ChatMessage => ({ role: "user", content })
const answer = (text: string): ChatMessage => ({ role: "assistant", content: [{ type: "text", text }] })
const large = "x".repeat(1_040_000)
const longResponse: ChatMessage = {
  role: "assistant",
  content: [
    { type: "reasoning", field: "reasoning_content", text: large },
    { type: "text", text: "Done." },
  ],
}
const emptySkills = { skills: [], byName: new Map() }
const summaryClient = (summary = "Task and progress summarized."): InferenceClient => ({
  model: "fake",
  complete: vi.fn(),
  streamChat: vi.fn<InferenceClient["streamChat"]>(async function* () {
    yield { type: "text_delta", text: summaryFixture(summary) }
  }),
})

describe("bounded compaction", () => {
  it("rejects a truncated summary without changing the conversation", async () => {
    const client = summaryClient()
    client.streamChat = vi.fn<InferenceClient["streamChat"]>(async function* () {
      yield { type: "text_delta", text: "## Goal\nAn unfinished summary" }
      yield { type: "finish", reason: "length" }
    })
    const messages = [user("task"), longResponse, user("continue")]
    const original = structuredClone(messages)
    await expect(compactConversation(messages, { client })).rejects.toThrow("did not finish its summary (length)")
    expect(messages).toEqual(original)
  })

  it("removes an oversized recent turn and stays below the trigger over four follow-ups", async () => {
    let messages = [user("old task"), answer("old answer"), user("large task"), longResponse]
    const client = summaryClient()
    const result = await compactConversation(messages, { client, targetTokens: 125_000 })
    messages = [compactionSummaryMessage(result.summary), ...result.keptMessages]
    for (let turn = 0; turn < 4; turn += 1) {
      messages.push(user("continue"), answer("continued"))
      expect(estimateMessageTokens(messages)).toBeLessThan(250_000)
    }
    expect(client.streamChat).toHaveBeenCalledOnce()
  })

  it("retains native reasoning and an entire parallel tool exchange inside a long turn", async () => {
    const exchange: ChatMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", field: "reasoning_content", text: "Need both files." },
          { type: "tool_call", toolCall: { id: "a", name: "read", arguments: "{}" } },
          { type: "tool_call", toolCall: { id: "b", name: "read", arguments: "{}" } },
        ],
      },
      { role: "tool", toolCallId: "a", content: "first file" },
      { role: "tool", toolCallId: "b", content: "second file" },
    ]
    const result = await compactConversation([user("task"), longResponse, ...exchange], {
      client: summaryClient(),
      targetTokens: 10_000,
    })
    expect(result.keptMessages).toEqual(exchange)
    expect(result.keptMessages[0]).toBe(exchange[0])
  })

  it("summarizes a single oversized tool exchange and preserves unanswered steering verbatim", async () => {
    const messages: ChatMessage[] = [
      user("task"),
      {
        role: "assistant",
        content: [
          { type: "reasoning", field: "reasoning_content", text: large },
          { type: "tool_call", toolCall: { id: "a", name: "read", arguments: "{}" } },
        ],
      },
      { role: "tool", toolCallId: "a", content: "result" },
      user("focus on tests"),
      user("use Bun"),
    ]
    const result = await compactConversation(messages, { client: summaryClient(), targetTokens: 10_000 })
    expect(result.keptMessages).toEqual(messages.slice(-2))
  })

  it("rejects a summary that leaves insufficient headroom without changing history", async () => {
    const messages = [user("task"), longResponse, user("continue")]
    const snapshot = structuredClone(messages)
    await expect(
      compactConversation(messages, { client: summaryClient(large), targetTokens: 125_000 }),
    ).rejects.toThrow("did not free enough")
    expect(messages).toEqual(snapshot)
  })

  it("rejects a non-shrinking summary even when the caller does not supply a target", async () => {
    await expect(
      compactConversation([user("hi"), answer("hello")], { client: summaryClient("Long summary.".repeat(100)) }),
    ).rejects.toThrow("did not free enough")
  })

  it("preserves Unicode characters across summary request boundaries", async () => {
    const requests: StreamChatOptions[] = []
    const client = summaryClient()
    client.streamChat = vi.fn<InferenceClient["streamChat"]>(async function* (request) {
      requests.push(request)
      yield { type: "text_delta", text: summaryFixture("Summary.") }
    })
    await compactConversation([user(`a${"😀".repeat(10_000)}`), answer("done"), user("continue")], {
      client,
      maxInputTokens: 4_000,
      targetTokens: 2_000,
    })
    expect(requests.length).toBeGreaterThan(1)
    for (const request of requests) {
      const characters = Array.from(String(request.messages[0].content))
      expect(
        characters.some(
          (character) =>
            character.length === 1 && character.charCodeAt(0) >= 0xd800 && character.charCodeAt(0) <= 0xdfff,
        ),
      ).toBe(false)
    }
  })

  it("refuses to spend a summary request when the latest prompt cannot fit", async () => {
    const client = summaryClient()
    await expect(
      compactConversation([user("task"), answer("done"), user(large)], {
        client,
        targetTokens: 10_000,
      }),
    ).rejects.toThrow("latest input")
    expect(client.streamChat).not.toHaveBeenCalled()
  })

  it("bounds summary requests and carries the previous summary across chunks", async () => {
    const requests: StreamChatOptions[] = []
    const client = summaryClient()
    client.streamChat = vi.fn<InferenceClient["streamChat"]>(async function* (request) {
      requests.push(request)
      yield { type: "text_delta", text: summaryFixture("Summary so far.") }
    })
    await compactConversation([user(`${"a".repeat(40_000)}TAIL_MARKER`), answer("done"), user("continue")], {
      client,
      maxInputTokens: 4_000,
      targetTokens: 2_000,
    })
    expect(requests.length).toBeGreaterThan(1)
    expect(requests.every((request) => requestContextEstimator(request)(request.messages) <= 4_000)).toBe(true)
    expect(requests[1].messages[0].content).toContain("Summary so far.")
    expect(requests.at(-1)?.messages[0].content).toContain("TAIL_MARKER")
  })

  it("includes the ends of long assistant messages and tool results in bounded summary requests", async () => {
    const requests: StreamChatOptions[] = []
    const client = summaryClient()
    client.streamChat = vi.fn<InferenceClient["streamChat"]>(async function* (request) {
      requests.push(request)
      yield { type: "text_delta", text: summaryFixture("Summary.") }
    })
    const messages: ChatMessage[] = [
      user("task"),
      answer(`${"a".repeat(12_000)}ASSISTANT_TAIL`),
      {
        role: "assistant",
        content: [{ type: "tool_call", toolCall: { id: "a", name: "read", arguments: "{}" } }],
      },
      { role: "tool", toolCallId: "a", content: `${"b".repeat(12_000)}TOOL_TAIL` },
      user("continue"),
    ]
    await compactConversation(messages, { client, maxInputTokens: 4_000, targetTokens: 2_000 })
    expect(requests.some((request) => String(request.messages[0].content).includes("ASSISTANT_TAIL"))).toBe(true)
    expect(requests.some((request) => String(request.messages[0].content).includes("TOOL_TAIL"))).toBe(true)
    expect(requests.every((request) => requestContextEstimator(request)(request.messages) <= 4_000)).toBe(true)
  })
})

describe("autocompaction at model request boundaries", () => {
  it.each([
    true,
    false,
  ])("publishes the final context after interruption (provider usage: %s)", async (reportsUsage) => {
    const controller = new AbortController()
    const client = summaryClient()
    const partial = "Partial answer. ".repeat(1_000)
    client.streamChat = vi.fn<InferenceClient["streamChat"]>(async function* () {
      yield { type: "text_delta", text: partial }
      if (reportsUsage)
        yield { type: "usage", usage: { promptTokens: 7_000, completionTokens: 2_000, totalTokens: 9_000 } }
      controller.abort()
    })
    const events = await collect(
      runAgent("task", [], {
        client,
        tools: [],
        skills: emptySkills,
        projectContext: [],
        signal: controller.signal,
      }),
    )
    const messages = [user("task"), answer(partial)]
    expect(events.at(-1)).toEqual({ type: "interrupted", messages })
    const expectedTokens = reportsUsage ? 9_000 : requestContextEstimator({ tools: [] })(messages)
    expect(events.at(-2)).toMatchObject({ type: "context", messageCount: 2, tokens: expectedTokens })
  })

  it("uses the preceding turn's observed context before the next request", async () => {
    const history = [user("task"), answer("prior response ".repeat(300))]
    const client = summaryClient("Short summary.")
    const events = await collect(
      runAgent("continue", history, {
        client,
        tools: [],
        skills: emptySkills,
        projectContext: [],
        historyTokens: 10_000,
        autoCompactAtTokens: 10_000,
      }),
    )
    expect(events[0]).toMatchObject({ type: "context", tokens: expect.any(Number) })
    expect(events[1]).toEqual({ type: "compaction", phase: "start" })
    expect(events.filter((event) => event.type === "compaction" && event.phase === "complete")).toHaveLength(1)
    expect(events.at(-1)?.type).toBe("complete")
  })

  it.each(["request", "summary"])("surfaces a rejected %s without retrying or replacing history", async (phase) => {
    const client = summaryClient()
    client.streamChat = vi.fn<InferenceClient["streamChat"]>(() => {
      throw new Error("Context length exceeded")
    })
    const checkpoint = vi.fn()
    const history = [user("task"), phase === "summary" ? longResponse : answer("done")]
    const original = structuredClone(history)
    const events = await collect(
      runAgent("continue", history, {
        client,
        tools: [],
        skills: emptySkills,
        projectContext: [],
        onCompaction: checkpoint,
      }),
    )
    expect(client.streamChat).toHaveBeenCalledOnce()
    expect(checkpoint).not.toHaveBeenCalled()
    expect(history).toEqual(original)
    expect(events.at(-1)).toEqual({ type: "error", message: "Context length exceeded", messages: [user("continue")] })
  })

  it("uses provider usage to trigger compaction when character estimates undercount the request", async () => {
    let requests = 0
    const client = summaryClient()
    client.streamChat = vi.fn<InferenceClient["streamChat"]>(async function* () {
      requests += 1
      if (requests === 1) {
        yield { type: "tool_call", toolCall: { id: "a", name: "read", arguments: "{}" } }
        yield { type: "usage", usage: { promptTokens: 7_000, completionTokens: 3_000, totalTokens: 10_000 } }
      } else if (requests === 2) yield { type: "text_delta", text: summaryFixture("Task summarized.") }
      else yield { type: "text_delta", text: "Finished." }
    })
    const events = await collect(
      runAgent("task ".repeat(400), [], {
        client,
        tools: [],
        skills: emptySkills,
        projectContext: [],
        autoCompactAtTokens: 8_000,
      }),
    )
    expect(requests).toBe(3)
    expect(events.some((event) => event.type === "context" && (event.tokens ?? 0) >= 10_000)).toBe(true)
    expect(events.filter((event) => event.type === "compaction" && event.phase === "complete")).toHaveLength(1)
    expect(events.at(-1)?.type).toBe("complete")
  })

  it("compacts inside one tool loop, checkpoints before continuing, and returns only the continuation", async () => {
    const requests: StreamChatOptions[] = []
    let checkpointed = false
    const client = summaryClient()
    client.streamChat = vi.fn<InferenceClient["streamChat"]>(async function* (request) {
      requests.push(structuredClone({ ...request, signal: undefined }))
      if (requests.length === 1) {
        yield { type: "reasoning_delta", field: "reasoning_content", text: large }
        yield { type: "tool_call", toolCall: { id: "a", name: "read", arguments: "{}" } }
      } else if (requests.length === 2) {
        yield { type: "text_delta", text: summaryFixture("Task and progress summarized.") }
      } else {
        expect(checkpointed).toBe(true)
        expect(request.messages[0].content).toContain("[Compacted conversation summary]")
        expect(requestContextEstimator({ tools: [] })(request.messages)).toBeLessThan(125_000)
        yield { type: "text_delta", text: "Finished." }
      }
    })
    const events = await collect(
      runAgent("task", [], {
        client,
        tools: [],
        skills: emptySkills,
        projectContext: [],
        onCompaction: () => {
          checkpointed = true
        },
      }),
    )
    expect(requests).toHaveLength(3)
    expect(events.at(-1)).toEqual({ type: "complete", messages: [answer("Finished.")] })
    expect(events.filter((event) => event.type === "compaction" && event.phase === "complete")).toHaveLength(1)
  })

  it("compacts resumed history before the first inference and includes steering received during summarization", async () => {
    const steering = new SteeringInbox(async () => {})
    let requests = 0
    const checkpoint = vi.fn()
    const client = summaryClient()
    client.streamChat = vi.fn<InferenceClient["streamChat"]>(async function* (request) {
      requests += 1
      if (requests === 1) {
        const acceptance = steering.accept({ role: "user", content: "new direction" })
        if (!acceptance.accepted) throw new Error("Steering was unexpectedly closed")
        await acceptance.persisted
        yield { type: "text_delta", text: summaryFixture("Summary.") }
      } else {
        expect(request.messages).toContainEqual(user("new direction"))
        expect(request.messages).toContainEqual(user("continue"))
        yield { type: "text_delta", text: "Done." }
      }
    })
    const events = await collect(
      runAgent("continue", [user("task"), longResponse], {
        client,
        tools: [],
        skills: emptySkills,
        projectContext: [],
        steering,
        onCompaction: checkpoint,
      }),
    )
    expect(requests).toBe(2)
    expect(checkpoint).toHaveBeenCalledWith(expect.anything(), 0, [user("continue")])
    expect(events.at(-1)).toEqual({ type: "complete", messages: [user("new direction"), answer("Done.")] })
  })

  it("keeps original history and stops before another request if checkpoint persistence fails", async () => {
    const client = summaryClient()
    const history = [user("task"), longResponse]
    const events = await collect(
      runAgent("continue", history, {
        client,
        tools: [],
        skills: emptySkills,
        projectContext: [],
        onCompaction: () => {
          throw new Error("Disk full")
        },
      }),
    )
    expect(client.streamChat).toHaveBeenCalledOnce()
    expect(events.at(-1)).toEqual({ type: "error", message: "Disk full", messages: [user("continue")] })
    expect(history[1]).toEqual(longResponse)
    expect(events.some((event) => event.type === "compaction" && event.phase === "complete")).toBe(false)
  })

  it("does not accept a partially streamed summary after cancellation", async () => {
    const controller = new AbortController()
    const checkpoint = vi.fn()
    const client = summaryClient()
    client.streamChat = vi.fn<InferenceClient["streamChat"]>(async function* () {
      yield { type: "text_delta", text: "Partial summary" }
      controller.abort()
    })
    const events = await collect(
      runAgent("continue", [user("task"), longResponse], {
        client,
        tools: [],
        skills: emptySkills,
        projectContext: [],
        signal: controller.signal,
        onCompaction: checkpoint,
      }),
    )
    expect(checkpoint).not.toHaveBeenCalled()
    expect(events.at(-1)).toEqual({ type: "interrupted", messages: [user("continue")] })
    expect(client.streamChat).toHaveBeenCalledOnce()
  })
})

async function collect(events: AsyncGenerator<AgentEvent>) {
  const result: AgentEvent[] = []
  for await (const event of events) result.push(event)
  return result
}

describe("authoritative request counts and overflow recovery", () => {
  const options = { tools: [], skills: emptySkills, projectContext: [] }

  it("compacts before inference when the serving tokenizer reports more tokens than the character estimate", async () => {
    const client = summaryClient()
    const history = [user("task"), answer("HISTORY ".repeat(200))]
    client.countTokens = vi.fn(async (request: StreamChatOptions) =>
      request.messages.some(
        (message) =>
          message.role === "assistant" &&
          message.content.some((part) => part.type === "text" && part.text.includes("HISTORY")),
      )
        ? 25_000
        : 1_000,
    )
    const events = await collect(runAgent("continue", history, { ...options, client, autoCompactAtTokens: 8_000 }))
    expect(events.some((event) => event.type === "context" && event.tokens === 25_000)).toBe(true)
    expect(events.filter((event) => event.type === "compaction" && event.phase === "complete")).toHaveLength(1)
    expect(events.at(-1)?.type).toBe("complete")
    expect(client.streamChat).toHaveBeenCalledTimes(2)
  })

  it("trusts the serving count when a character estimate would compact unnecessarily", async () => {
    const client = summaryClient()
    client.countTokens = vi.fn(async () => 100)
    const events = await collect(
      runAgent("task", [user("x".repeat(40_000)), answer("done")], {
        ...options,
        client,
        autoCompactAtTokens: 8_000,
      }),
    )
    expect(events.some((event) => event.type === "compaction")).toBe(false)
    expect(events.some((event) => event.type === "context" && event.tokens === 100)).toBe(true)
    expect(client.streamChat).toHaveBeenCalledOnce()
  })

  it("does not silently fall back to estimates when a managed tokenizer fails", async () => {
    const client = summaryClient()
    client.countTokens = async () => {
      throw new Error("Tokenizer unavailable")
    }
    const events = await collect(runAgent("task", [], { ...options, client }))
    expect(events.at(-1)).toMatchObject({ type: "error", message: "Tokenizer unavailable" })
    expect(client.streamChat).not.toHaveBeenCalled()
  })

  it("checkpoints compaction before retrying a rejected input and retains the current prompt", async () => {
    const client = summaryClient()
    let requests = 0
    let checkpointed = false
    client.streamChat = vi.fn<InferenceClient["streamChat"]>(async function* (request) {
      if (request.systemPrompt?.startsWith("You are a conversation summarizer")) {
        yield { type: "text_delta", text: summaryFixture("Earlier work preserved.") }
        return
      }
      requests += 1
      if (requests === 1) throw new ContextOverflowError("Too many input tokens")
      expect(checkpointed).toBe(true)
      expect(request.messages).toContainEqual(user("continue"))
      expect(request.messages[0].content).toContain("Earlier work preserved")
      yield { type: "text_delta", text: "Finished." }
    })
    const history = [user("task"), answer("old work ".repeat(12_000))]
    const events = await collect(
      runAgent("continue", history, {
        ...options,
        client,
        onCompaction: () => {
          checkpointed = true
        },
      }),
    )
    expect(requests).toBe(2)
    expect(events.at(-1)).toEqual({ type: "complete", messages: [answer("Finished.")] })
    expect(events).toContainEqual({ type: "model", phase: "retry" })
    expect(history).toHaveLength(2)
  })

  it.each(["output", "cancel", "checkpoint"])("does not retry after %s", async (failure) => {
    const controller = new AbortController()
    const client = summaryClient()
    let requests = 0
    client.streamChat = vi.fn<InferenceClient["streamChat"]>(async function* (request) {
      if (request.systemPrompt?.startsWith("You are a conversation summarizer")) {
        yield { type: "text_delta", text: summaryFixture("Summary.") }
        return
      }
      requests += 1
      if (failure === "output") yield { type: "text_delta", text: "Already visible" }
      if (failure === "cancel") controller.abort()
      throw new ContextOverflowError("Too many input tokens")
    })
    const checkpoint = vi.fn(() => {
      throw new Error("Disk full")
    })
    const events = await collect(
      runAgent("continue", [user("task"), answer("x".repeat(100_000))], {
        ...options,
        client,
        signal: controller.signal,
        onCompaction: checkpoint,
      }),
    )
    expect(requests).toBe(1)
    expect(events.at(-1)?.type).toBe(failure === "cancel" ? "interrupted" : "error")
    if (failure === "checkpoint") expect(events.at(-1)).toMatchObject({ message: "Disk full" })
    else expect(checkpoint).not.toHaveBeenCalled()
  })

  it("stops clearly when a new prompt alone cannot be compacted", async () => {
    const client = summaryClient()
    client.streamChat = vi.fn<InferenceClient["streamChat"]>(() => {
      throw new ContextOverflowError("Too large")
    })
    const events = await collect(runAgent("x".repeat(10_000), [], { ...options, client }))
    expect(client.streamChat).toHaveBeenCalledOnce()
    expect(events.at(-1)).toMatchObject({ type: "error", message: "Not enough conversation history to compact." })
  })

  it("counts summary chunks with the serving tokenizer and preserves their complete Unicode content", async () => {
    const client = summaryClient()
    const chunks: string[] = []
    client.countTokens = vi.fn(async (request: StreamChatOptions) => String(request.messages[0].content).length + 500)
    client.streamChat = vi.fn<InferenceClient["streamChat"]>(async function* (request) {
      expect(await client.countTokens?.(request)).toBeLessThanOrEqual(4_000)
      const input = String(request.messages[0].content)
      expect(Buffer.from(input, "utf8").toString("utf8")).toBe(input)
      chunks.push(input)
      yield { type: "text_delta", text: summaryFixture("Summary.") }
    })
    await compactConversation([user(`${"漢🌍".repeat(4_000)}TAIL_MARKER`), answer("done"), user("next")], {
      client,
      maxInputTokens: 4_000,
      targetTokens: 2_000,
    })
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.at(-1)).toContain("TAIL_MARKER")
  })

  it("reduces rejected summary chunks before retrying and stops repeated rejections", async () => {
    const client = summaryClient()
    const lengths: number[] = []
    client.streamChat = vi.fn<InferenceClient["streamChat"]>((request) => {
      lengths.push(String(request.messages[0].content).length)
      throw new ContextOverflowError("Summary input too large")
    })
    const history = [user("x".repeat(100_000)), answer("done"), user("next")]
    const original = structuredClone(history)
    await expect(compactConversation(history, { client, maxInputTokens: 8_000 })).rejects.toThrow(
      "Summary input too large",
    )
    expect(lengths).toHaveLength(4)
    expect(lengths.slice(1).every((length, index) => length < lengths[index])).toBe(true)
    expect(history).toEqual(original)
  })
})

it("recovers inside a tool loop without executing earlier tools again", async () => {
  const client = summaryClient()
  let requests = 0
  client.streamChat = vi.fn<InferenceClient["streamChat"]>(async function* (request) {
    if (request.systemPrompt?.startsWith("You are a conversation summarizer")) {
      yield { type: "text_delta", text: summaryFixture("Read already completed.") }
      return
    }
    requests += 1
    if (requests === 1) {
      yield { type: "text_delta", text: "notes ".repeat(16_000) }
      yield { type: "tool_call", toolCall: { id: "read-once", name: "read", arguments: '{"path":"package.json"}' } }
    } else if (requests === 2) throw new ContextOverflowError("Too large after tool result")
    else yield { type: "text_delta", text: "Done." }
  })
  const checkpoint = vi.fn()
  const events = await collect(
    runAgent("task", [], {
      client,
      tools: TOOL_DEFINITIONS.filter((tool) => tool.name === "read"),
      skills: emptySkills,
      projectContext: [],
      onCompaction: checkpoint,
    }),
  )
  expect(requests).toBe(3)
  expect(events.filter((event) => event.type === "tool" && event.phase === "start")).toHaveLength(1)
  expect(checkpoint).toHaveBeenCalledOnce()
  expect(checkpoint.mock.calls[0][2]).toContainEqual(expect.objectContaining({ role: "tool", toolCallId: "read-once" }))
  expect(events.at(-1)).toEqual({ type: "complete", messages: [answer("Done.")] })
})

it("recovers a rejected summary chunk and still summarizes the tail", async () => {
  const client = summaryClient()
  let rejected = false
  const accepted: string[] = []
  client.streamChat = vi.fn<InferenceClient["streamChat"]>(async function* (request) {
    if (!rejected) {
      rejected = true
      throw new ContextOverflowError("Too large")
    }
    accepted.push(String(request.messages[0].content))
    yield { type: "text_delta", text: summaryFixture("Summary.") }
  })
  const result = await compactConversation(
    [user(`${"x".repeat(50_000)}TAIL_MARKER`), answer("done"), user("continue")],
    {
      client,
      maxInputTokens: 8_000,
      targetTokens: 4_000,
    },
  )
  expect(rejected).toBe(true)
  expect(accepted.length).toBeGreaterThan(1)
  expect(accepted.at(-1)).toContain("TAIL_MARKER")
  expect(result.keptMessages).toEqual([user("continue")])
})

it("bounds repeated context rejections even when there is still history to compact", async () => {
  const client = summaryClient()
  let requests = 0
  client.streamChat = vi.fn<InferenceClient["streamChat"]>(async function* (request) {
    if (request.systemPrompt?.startsWith("You are a conversation summarizer")) {
      yield { type: "text_delta", text: summaryFixture("Earlier work.") }
      return
    }
    requests += 1
    throw new ContextOverflowError("Still too large")
  })
  const history = Array.from({ length: 16 }, (_, index) => [user(`Task ${index}`), answer("x".repeat(8_000))]).flat()
  const events = await collect(
    runAgent("next", history, { client, tools: [], skills: emptySkills, projectContext: [] }),
  )
  expect(requests).toBe(3)
  expect(events.at(-1)).toMatchObject({ type: "error", message: "Still too large" })
})

it("does not accept a summary whose serving token count exceeds the target", async () => {
  const client = summaryClient()
  const history = [user("task"), answer("x".repeat(40_000)), user("next")]
  const original = structuredClone(history)
  await expect(
    compactConversation(history, {
      client,
      targetTokens: 4_000,
      countContextTokens: async (messages) =>
        String(messages[0].content).includes("[Compacted conversation summary]") ? 5_000 : 1_000,
    }),
  ).rejects.toThrow("did not free enough context")
  expect(history).toEqual(original)
})
