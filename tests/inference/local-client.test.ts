import { afterEach, describe, expect, it, vi } from "vitest"
import { LlamaCppClient } from "../../src/inference/local-client.js"
import type { LocalThinkingLevel } from "../../src/inference/local-thinking.js"

afterEach(() => vi.restoreAllMocks())

describe("LlamaCppClient", () => {
  it("applies the saved effort to inference and token counting while preserving reasoning history", async () => {
    let level: LocalThinkingLevel | undefined = "medium"
    const requests: Array<Record<string, unknown>> = []
    const client = new LlamaCppClient({
      model: "Qwen/Qwen3.8-27B",
      inferenceURL: "http://127.0.0.1:18765/v1/chat/completions",
      thinkingLevel: () => level,
      fetch: async (url, init) => {
        requests.push(JSON.parse(String(init?.body)))
        return String(url).endsWith("/input_tokens")
          ? Response.json({ input_tokens: 123 })
          : new Response("data: [DONE]\n\n")
      },
    })
    const options = {
      messages: [
        {
          role: "assistant" as const,
          content: [
            { type: "reasoning" as const, text: "Prior reasoning", field: "reasoning_content" as const },
            { type: "text" as const, text: "Prior answer" },
          ],
        },
      ],
      tools: [{ name: "read", description: "Read", parameters: { type: "object" } }],
    }
    await client.countTokens(options)
    await client.streamChat(options).next()
    expect(requests[0]).toEqual(requests[1])
    expect(requests[0]).toMatchObject({
      reasoning_effort: "medium",
      messages: expect.arrayContaining([expect.objectContaining({ reasoning_content: "Prior reasoning" })]),
    })
    level = "off"
    await client.streamChat(options).next()
    expect(requests[2]).toMatchObject({ chat_template_kwargs: { enable_thinking: false } })
    expect(requests[2]).not.toHaveProperty("reasoning_effort")
    level = undefined
    await client.streamChat(options).next()
    expect(requests[3]).not.toHaveProperty("reasoning_effort")
    expect(requests[3]).not.toHaveProperty("chat_template_kwargs")
  })
  it("streams OpenAI-compatible tool calls without Fireworks-only fields", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n', {
          headers: { "content-type": "text/event-stream" },
        }),
    )
    const client = new LlamaCppClient({
      model: "openai/gpt-oss-20b",
      inferenceURL: "http://127.0.0.1:18765/v1/chat/completions",
      fetch: fetchMock as typeof fetch,
    })

    const events = []
    for await (const event of client.streamChat({
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
    })) {
      events.push(event)
    }

    expect(events).toEqual([{ type: "text_delta", text: "Hi" }])
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body.model).toBe("openai/gpt-oss-20b")
    expect(body).not.toHaveProperty("service_tier")
    expect(body).not.toHaveProperty("reasoning_effort")
    expect(body.tools).toEqual([
      { type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object" } } },
    ])
  })

  it("rejects non-localhost HTTP endpoints", () => {
    expect(
      () =>
        new LlamaCppClient({
          model: "openai/gpt-oss-20b",
          inferenceURL: "http://example.com/v1/chat/completions",
        }),
    ).toThrow("must use HTTPS")
  })
})

describe("local request token counting", () => {
  it("counts the identical serialized request using the serving model without generating output", async () => {
    const requests: Array<{ url: string; body: unknown; signal: AbortSignal | null | undefined }> = []
    const client = new LlamaCppClient({
      model: "local",
      inferenceURL: "http://127.0.0.1:1234/v1/chat/completions",
      apiKey: "test-only",
      fetch: async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)), signal: init?.signal })
        expect(init?.headers).toMatchObject({ authorization: "Bearer test-only" })
        return String(url).endsWith("/input_tokens")
          ? Response.json({ input_tokens: 321 })
          : new Response("data: [DONE]\n\n")
      },
    })
    const controller = new AbortController()
    const request = {
      messages: [{ role: "user" as const, content: "こんにちは 🌍" }],
      systemPrompt: "Fixed instructions",
      tools: [{ name: "read", description: "Read", parameters: { type: "object" } }],
      signal: controller.signal,
    }
    expect(await client.countTokens(request)).toBe(321)
    await client.streamChat(request).next()
    expect(requests.map((request) => request.url)).toEqual([
      "http://127.0.0.1:1234/v1/chat/completions/input_tokens",
      "http://127.0.0.1:1234/v1/chat/completions",
    ])
    expect(requests[0].body).toEqual(requests[1].body)
    expect(requests[0].signal).toBe(controller.signal)
  })

  it.each([
    null,
    {},
    { input_tokens: -1 },
    { input_tokens: 1.5 },
    { input_tokens: "123" },
  ])("rejects an invalid count: %j", async (body) => {
    const client = new LlamaCppClient({
      model: "local",
      inferenceURL: "http://127.0.0.1:1234/v1/chat/completions",
      fetch: async () => Response.json(body),
    })
    await expect(client.countTokens({ messages: [] })).rejects.toThrow("invalid input token count")
  })
})
