import { afterEach, describe, expect, it, vi } from "vitest"
import { LlamaCppClient } from "../../src/inference/local-client.js"
import type { LocalThinkingLevel } from "../../src/inference/local-thinking.js"

afterEach(() => vi.restoreAllMocks())

/** A body that delivers one chunk and then never settles another read. */
function stalledBody(head: string) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(head))
    },
    pull: () => new Promise<void>(() => {}),
  })
}

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
            {
              type: "reasoning" as const,
              text: "Prior reasoning",
              field: "reasoning_content" as const,
            },
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
      messages: expect.arrayContaining([
        expect.objectContaining({ reasoning_content: "Prior reasoning" }),
      ]),
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
  it.each([
    ["Qwen/Qwen3.8-27B", "xhigh", { chat_template_kwargs: { enable_thinking: false } }],
    ["openai/gpt-oss-20b", "high", { reasoning_effort: "low" }],
    ["zai-org/GLM-5.3", "max", { reasoning_effort: "low" }],
    ["google/gemma-4-12B-it", "on", { chat_template_kwargs: { enable_thinking: false } }],
    ["LiquidAI/LFM2.5-2.6B", undefined, {}],
  ] as const)("spends the least reasoning %s allows when a request asks for it", async (model, saved, expected) => {
    const requests: Array<Record<string, unknown>> = []
    const client = new LlamaCppClient({
      model,
      inferenceURL: "http://127.0.0.1:18765/v1/chat/completions",
      thinkingLevel: () => saved,
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)))
        return new Response("data: [DONE]\n\n")
      },
    })
    const messages = [{ role: "user" as const, content: "Summarize." }]
    await client.streamChat({ messages, minimalReasoning: true }).next()
    await client.streamChat({ messages }).next()
    const minimal = requests[0]
    const { reasoning_effort, chat_template_kwargs, ...rest } = minimal
    expect({
      ...(reasoning_effort === undefined ? {} : { reasoning_effort }),
      ...(chat_template_kwargs === undefined ? {} : { chat_template_kwargs }),
    }).toEqual(expected)
    expect(rest.model).toBe(model)
    // The saved effort is untouched for ordinary requests.
    if (saved === "xhigh" || saved === "high" || saved === "max")
      expect(requests[1]).toMatchObject({ reasoning_effort: saved })
    if (saved === "on")
      expect(requests[1]).toMatchObject({ chat_template_kwargs: { enable_thinking: true } })
  })

  it("checks the managed server before every request", async () => {
    const fetchMock = vi.fn(async () => new Response("data: [DONE]\n\n"))
    let exit: Error | undefined
    const client = new LlamaCppClient({
      model: "openai/gpt-oss-20b",
      inferenceURL: "http://127.0.0.1:18765/v1/chat/completions",
      fetch: fetchMock as unknown as typeof fetch,
      assertServing: () => {
        if (exit) throw exit
      },
    })
    const request = { messages: [{ role: "user" as const, content: "hello" }] }
    await client.streamChat(request).next()
    expect(fetchMock).toHaveBeenCalledOnce()
    exit = new Error("The local model server exited unexpectedly (code 137).")
    await expect(client.streamChat(request).next()).rejects.toBe(exit)
    await expect(client.countTokens(request)).rejects.toBe(exit)
    await expect(client.complete(request.messages)).rejects.toBe(exit)
    expect(fetchMock).toHaveBeenCalledOnce()
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
      {
        type: "function",
        function: { name: "read", description: "Read a file", parameters: { type: "object" } },
      },
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
    const requests: Array<{ url: string; body: unknown; signal: AbortSignal | null | undefined }> =
      []
    const client = new LlamaCppClient({
      model: "local",
      inferenceURL: "http://127.0.0.1:1234/v1/chat/completions",
      apiKey: "test-only",
      fetch: async (url, init) => {
        requests.push({
          url: String(url),
          body: JSON.parse(String(init?.body)),
          signal: init?.signal,
        })
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
    // The request signal derives from the caller's: cancelling the turn cancels the request.
    expect(requests[0].signal?.aborted).toBe(false)
    controller.abort()
    expect(requests[0].signal?.aborted).toBe(true)
  })

  it("abandons a stream that stops delivering bytes, naming the idle limit", async () => {
    const client = new LlamaCppClient({
      model: "local",
      inferenceURL: "http://127.0.0.1:1234/v1/chat/completions",
      idleTimeoutMs: 20,
      fetch: async () =>
        new Response(stalledBody('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n')),
    })
    const events: unknown[] = []
    await expect(
      (async () => {
        for await (const event of client.streamChat({ messages: [] })) events.push(event)
      })(),
    ).rejects.toThrow("Local model sent no data for 20 ms; the request timed out.")
    expect(events).toEqual([{ type: "text_delta", text: "Hi" }])
  })

  it("restarts the idle clock on every chunk", async () => {
    const client = new LlamaCppClient({
      model: "local",
      inferenceURL: "http://127.0.0.1:1234/v1/chat/completions",
      idleTimeoutMs: 40,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              for (let index = 0; index < 5; index += 1) {
                await new Promise((resolve) => setTimeout(resolve, 25))
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: {"choices":[{"delta":{"content":"${index}"}}]}\n\n`,
                  ),
                )
              }
              controller.close()
            },
          }),
        ),
    })
    const texts: string[] = []
    for await (const event of client.streamChat({ messages: [] })) {
      if (event.type === "text_delta") texts.push(event.text)
    }
    expect(texts).toEqual(["0", "1", "2", "3", "4"])
  })

  it.each([
    ["headers", () => new Promise<Response>(() => {})],
    ["the JSON body", async () => new Response(stalledBody("{"))],
  ])("bounds a token count whose %s never arrive", async (_what, fetchImpl) => {
    const client = new LlamaCppClient({
      model: "local",
      inferenceURL: "http://127.0.0.1:1234/v1/chat/completions",
      idleTimeoutMs: 20,
      fetch: fetchImpl,
    })
    await expect(client.countTokens({ messages: [] })).rejects.toThrow(
      "Local model sent no data for 20 ms; the request timed out.",
    )
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
