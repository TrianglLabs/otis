import { afterEach, describe, expect, it, vi } from "vitest"
import { FireworksClient, listToolCapableModels } from "../../src/inference/client.js"

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

  it.each([
    ["accounts/fireworks/models/gpt-oss-120b", "high"],
    ["accounts/fireworks/models/glm-5p2", "max"],
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

describe("listToolCapableModels", () => {
  it("paginates the public catalog and returns only serverless models with tool support", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          models: [
            model("accounts/fireworks/models/zeta", "Zeta", true, true, 128_000),
            model("accounts/fireworks/models/chat-only", "Chat only", true, false),
            model("accounts/fireworks/models/deployed", "Deployed", false, true),
          ],
          nextPageToken: "page-two",
        }),
      )
      .mockResolvedValueOnce(Response.json({ models: [model("accounts/fireworks/models/alpha", "Alpha", true, true)] }))

    const models = await listToolCapableModels("fw_test_key", {
      fetch: fetchMock as typeof fetch,
      modelsURL: "http://localhost/v1/accounts/fireworks/models",
    })

    expect(models).toEqual([
      { id: "accounts/fireworks/models/alpha", displayName: "Alpha" },
      { id: "accounts/fireworks/models/zeta", displayName: "Zeta", contextLength: 128_000 },
    ])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const firstURL = new URL(String(fetchMock.mock.calls[0][0]))
    expect(firstURL.searchParams.get("filter")).toBe("supports_serverless=true AND supports_tools=true")
    expect(firstURL.searchParams.get("pageSize")).toBe("200")
    const secondURL = new URL(String(fetchMock.mock.calls[1][0]))
    expect(secondURL.searchParams.get("pageToken")).toBe("page-two")
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({ authorization: "Bearer fw_test_key" })
  })

  it("rejects malformed catalog responses instead of accepting unverified model IDs", async () => {
    const fetchMock = vi.fn(async () => Response.json({ items: [] }))

    await expect(
      listToolCapableModels("fw_test_key", {
        fetch: fetchMock as typeof fetch,
        modelsURL: "http://localhost/models",
      }),
    ).rejects.toThrow("models response was invalid")
  })
})

function model(
  name: string,
  displayName: string,
  supportsServerless: boolean,
  supportsTools: boolean,
  contextLength?: number,
) {
  return { name, displayName, supportsServerless, supportsTools, contextLength }
}

function sseResponse(chunks: unknown[]) {
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`
  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}

async function collect<T>(events: AsyncGenerator<T>) {
  const result: T[] = []
  for await (const event of events) result.push(event)
  return result
}
