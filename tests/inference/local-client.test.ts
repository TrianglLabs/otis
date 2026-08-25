import { afterEach, describe, expect, it, vi } from "vitest"
import { LlamaCppClient } from "../../src/inference/local-client.js"

afterEach(() => vi.restoreAllMocks())

describe("LlamaCppClient", () => {
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
