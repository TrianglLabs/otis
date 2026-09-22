import { describe, expect, it, vi } from "vitest"
import { ContextOverflowError } from "../../src/inference/errors.js"
import { OllamaClient } from "../../src/inference/ollama-client.js"
import { OpenAICompatibleClient } from "../../src/inference/openai-compat.js"
import { createPairClient } from "../../src/inference/pair.js"
import type { ChatMessage, ChatStreamEvent } from "../../src/inference/types.js"

describe("Ollama native transport", () => {
  it("selects native Ollama and OpenAI-compatible LM Studio routes without probing", () => {
    const fetch = vi.fn()
    const config = { model: "chat", baseURL: "http://127.0.0.1:11434", fetch }
    expect(createPairClient({ ...config, engine: "ollama" })).toBeInstanceOf(OllamaClient)
    const lmStudio = createPairClient({ ...config, engine: "lmstudio" })
    expect(lmStudio).toBeInstanceOf(OpenAICompatibleClient)
    expect(lmStudio).not.toBeInstanceOf(OllamaClient)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("abandons an Ollama stream that stays silent past the idle limit", async () => {
    const client = new OllamaClient({
      model: "chat",
      baseURL: "http://127.0.0.1:11434",
      idleTimeoutMs: 20,
      fetch: (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(`${JSON.stringify({ message: { content: "Hi" } })}\n`),
              )
            },
            pull: () => new Promise<void>(() => {}),
          }),
        )) as typeof fetch,
    })
    const events: ChatStreamEvent[] = []
    await expect(
      (async () => {
        for await (const event of client.streamChat({ messages: [] })) events.push(event)
      })(),
    ).rejects.toThrow("Ollama sent no data for 20 ms; the request timed out.")
    expect(events).toEqual([{ type: "text_delta", text: "Hi" }])
  })

  it("disables truncation and shifting, streams UTF-8, and replays thinking and complete tool exchanges", async () => {
    const chunks = [
      { message: { thinking: "Inspect 日本語." } },
      {
        message: {
          tool_calls: [
            { id: "read-one", function: { name: "read", arguments: { path: "README.md" } } },
            { function: { name: "read", arguments: { path: "AGENTS.md" } } },
          ],
        },
      },
      { done: true, done_reason: "stop", prompt_eval_count: 100, eval_count: 25 },
    ]
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
      const data = new TextEncoder().encode(chunks.map((chunk) => JSON.stringify(chunk)).join("\n"))
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const byte of data) controller.enqueue(Uint8Array.of(byte))
            controller.close()
          },
        }),
      )
    })
    const client = new OllamaClient({
      model: "chat",
      baseURL: "http://127.0.0.1:11434/v1",
      fetch: fetch as typeof globalThis.fetch,
    })
    const events: ChatStreamEvent[] = []
    for await (const event of client.streamChat({
      messages: [{ role: "user", content: "Read the docs" }],
      tools: [],
    }))
      events.push(event)
    expect(events).toContainEqual({
      type: "reasoning_delta",
      field: "reasoning",
      text: "Inspect 日本語.",
    })
    expect(events).toContainEqual({
      type: "usage",
      usage: { promptTokens: 100, completionTokens: 25, totalTokens: 125 },
    })
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" })
    const calls = events.flatMap((event) => (event.type === "tool_call" ? [event.toolCall] : []))
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual({ id: "read-one", name: "read", arguments: '{"path":"README.md"}' })
    expect(calls[1].id).toMatch(/^call_/)
    const history: ChatMessage[] = [
      { role: "user", content: "Read the docs" },
      {
        role: "assistant",
        content: [
          { type: "reasoning", field: "reasoning", text: "Inspect 日本語." },
          ...calls.map((toolCall) => ({ type: "tool_call" as const, toolCall })),
        ],
      },
      ...calls.map((call) => ({
        role: "tool" as const,
        toolCallId: call.id,
        content: "File contents",
      })),
    ]
    await client.complete(history)
    expect(fetch.mock.calls[1][0]).toBe("http://127.0.0.1:11434/api/chat")
    const body = JSON.parse(String(fetch.mock.calls[1][1]?.body))
    expect(body).toMatchObject({ truncate: false, shift: false, stream: true })
    expect(body).not.toHaveProperty("options")
    expect(body.messages[2]).toMatchObject({
      thinking: "Inspect 日本語.",
      tool_calls: [
        { id: "read-one", function: { name: "read", arguments: { path: "README.md" } } },
        { id: calls[1].id },
      ],
    })
    expect(body.messages[3]).toEqual({
      role: "tool",
      tool_call_id: "read-one",
      tool_name: "read",
      content: "File contents",
    })
  })

  it.each(["http", "stream"])("recognizes an input overflow from %s", async (mode) => {
    const error = "the input length exceeds the context length"
    const client = new OllamaClient({
      model: "chat",
      baseURL: "http://127.0.0.1:11434",
      fetch: async () =>
        mode === "http"
          ? Response.json({ error }, { status: 400 })
          : new Response(JSON.stringify({ error })),
    })
    await expect(client.streamChat({ messages: [] }).next()).rejects.toBeInstanceOf(
      ContextOverflowError,
    )
  })

  it("sends adjacent user messages as one alternating-role message", async () => {
    const fetch = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response('{"message":{"content":"ok"},"done":true,"done_reason":"stop"}\n'),
    )
    const client = new OllamaClient({
      model: "chat",
      baseURL: "http://127.0.0.1:11434",
      fetch: fetch as typeof globalThis.fetch,
    })
    await client.complete([
      { role: "user", content: "[Compacted conversation summary]\n\nEarlier work." },
      { role: "user", content: "continue" },
      { role: "assistant", content: [{ type: "text", text: "Working." }] },
      { role: "user", content: "steer one" },
      { role: "user", content: [{ type: "text", text: "steer two" }] },
    ])
    const body = JSON.parse(String(fetch.mock.calls[0][1]?.body))
    expect(body.messages.map((message: { role: string }) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ])
    expect(body.messages[1].content).toBe(
      "[Compacted conversation summary]\n\nEarlier work.\n\ncontinue",
    )
    expect(body.messages[3]).toMatchObject({ content: "steer one\n\nsteer two", images: [] })
  })

  it("rejects an incomplete stream instead of accepting a partial summary", async () => {
    const client = new OllamaClient({
      model: "chat",
      baseURL: "http://127.0.0.1:11434",
      fetch: async () => new Response('{"message":{"content":"Partial"}}\n'),
    })
    await expect(client.complete([])).rejects.toThrow("before completing")
  })

  it.each(["http", "stream"])("rejects a reported allocation below 64K from %s", async (mode) => {
    const error = "maximum context length is 8192 tokens"
    const client = new OllamaClient({
      model: "chat",
      baseURL: "http://127.0.0.1:11434",
      fetch: async () =>
        mode === "http"
          ? Response.json({ error }, { status: 400 })
          : new Response(JSON.stringify({ error })),
    })
    const response = client.complete([])
    await expect(response).rejects.toThrow("at least 65,536 tokens (64K)")
    await expect(response).rejects.not.toBeInstanceOf(ContextOverflowError)
  })
})
