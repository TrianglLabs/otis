import { afterEach, describe, expect, it, vi } from "vitest"
import { FireworksClient } from "../../src/inference/client.js"

afterEach(() => vi.restoreAllMocks())

describe("FireworksClient", () => {
  it("streams a direct tool-capable chat request and preserves provider usage", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      sseResponse([
        { choices: [{ delta: { reasoning_content: "checking", content: "Working." } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: '{"path":"README.md"}' } }],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
        { choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } },
      ]),
    )
    const client = new FireworksClient({
      apiKey: "fw_test_key",
      model: "accounts/fireworks/models/tool-model",
      fetch: fetchMock as typeof fetch,
      inferenceURL: "http://localhost/v1/chat/completions",
    })

    const events = []
    for await (const event of client.streamChat({
      messages: [
        { role: "user", content: "Inspect the readme" },
        {
          role: "assistant",
          content: [
            { type: "reasoning", field: "reasoning_content", text: "Earlier reasoning" },
            { type: "tool_call", toolCall: { id: "old_call", name: "read", arguments: '{"path":"old"}' } },
          ],
        },
        { role: "tool", toolCallId: "old_call", content: "old result" },
      ],
      tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
      projectContext: [{ path: "/work/AGENTS.md", content: "Use strict TypeScript." }],
      now: new Date("2026-07-16T12:00:00Z"),
    })) {
      events.push(event)
    }

    expect(events).toEqual([
      { type: "reasoning_delta", field: "reasoning_content", text: "checking" },
      { type: "text_delta", text: "Working." },
      { type: "usage", usage: { promptTokens: 120, completionTokens: 30, totalTokens: 150 } },
      {
        type: "tool_call",
        toolCall: { id: "call_1", name: "read", arguments: '{"path":"README.md"}' },
      },
    ])

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe("http://localhost/v1/chat/completions")
    expect(init?.headers).toMatchObject({ authorization: "Bearer fw_test_key" })
    const body = JSON.parse(String(init?.body))
    expect(body).toMatchObject({
      model: "accounts/fireworks/models/tool-model",
      stream: true,
      stream_options: { include_usage: true },
      tools: [
        {
          type: "function",
          function: { name: "read", description: "Read a file", parameters: { type: "object" } },
        },
      ],
    })
    expect(body.service_tier).toBe("priority")
    expect(body).not.toHaveProperty("reasoning_effort")
    expect(body.messages[0].content).toContain("Use strict TypeScript.")
    expect(body.messages[0].content).toContain("2026-07-16")
    expect(body.messages[2]).toMatchObject({
      role: "assistant",
      reasoning_content: "Earlier reasoning",
      tool_calls: [{ id: "old_call", function: { name: "read", arguments: '{"path":"old"}' } }],
    })
    expect(body.messages[3]).toEqual({ role: "tool", tool_call_id: "old_call", content: "old result" })
  })

  it("surfaces provider errors without retrying through another service", async () => {
    const fetchMock = vi.fn(async () => new Response("invalid model", { status: 400 }))
    const client = new FireworksClient({
      apiKey: "fw_test_key",
      model: "accounts/fireworks/models/tool-model",
      fetch: fetchMock as typeof fetch,
      inferenceURL: "http://localhost/v1/chat/completions",
    })

    await expect(collect(client.streamChat({ messages: [{ role: "user", content: "hello" }] }))).rejects.toThrow(
      "Fireworks request failed with HTTP 400: invalid model",
    )
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it("serializes image input as an OpenAI-compatible data URL with images before text", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => sseResponse([]))
    const client = new FireworksClient({
      apiKey: "fw_test_key",
      model: "accounts/fireworks/models/vision-model",
      fetch: fetchMock as typeof fetch,
      inferenceURL: "http://localhost/v1/chat/completions",
    })

    await collect(
      client.streamChat({
        messages: [
          {
            role: "user",
            content: [
              { type: "image", data: "iVBORw==", mimeType: "image/png", name: "screen.png", sizeBytes: 4 },
              { type: "text", text: "What is shown?" },
            ],
          },
        ],
      }),
    )

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body.messages[1]).toEqual({
      role: "user",
      content: [
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw==" } },
        { type: "text", text: "What is shown?" },
      ],
    })
  })

  it("omits service_tier for Fast serving-path model IDs", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => sseResponse([]))
    const client = new FireworksClient({
      apiKey: "fw_test_key",
      model: "accounts/fireworks/routers/kimi-k3-fast",
      fetch: fetchMock as typeof fetch,
      inferenceURL: "http://localhost/v1/chat/completions",
    })

    await collect(client.streamChat({ messages: [{ role: "user", content: "hello" }] }))

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body.model).toBe("accounts/fireworks/routers/kimi-k3-fast")
    expect(body).not.toHaveProperty("service_tier")
  })

  it.each([
    ["accounts/fireworks/models/gpt-oss-120b", "high"],
    ["accounts/fireworks/models/glm-5p2", "max"],
    ["accounts/fireworks/routers/glm-5p2-fast", "max"],
  ] as const)("sends %s requests with %s reasoning", async (model, reasoningEffort) => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => sseResponse([]))
    const client = new FireworksClient({
      apiKey: "fw_test_key",
      model,
      fetch: fetchMock as typeof fetch,
      inferenceURL: "http://localhost/v1/chat/completions",
    })

    await collect(client.streamChat({ messages: [{ role: "user", content: "hello" }] }))

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body.reasoning_effort).toBe(reasoningEffort)
  })

  it("rejects non-HTTPS provider URLs outside local tests", () => {
    expect(
      () =>
        new FireworksClient({
          apiKey: "fw_test_key",
          model: "accounts/fireworks/models/tool-model",
          inferenceURL: "http://example.com/chat",
        }),
    ).toThrow("must use HTTPS")
  })
})

function sseResponse(chunks: unknown[]) {
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`
  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}

async function collect<T>(events: AsyncGenerator<T>) {
  const result: T[] = []
  for await (const event of events) result.push(event)
  return result
}
