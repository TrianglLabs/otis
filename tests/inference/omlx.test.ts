import { afterEach, describe, expect, it, vi } from "vitest"
import { compactionContextLength } from "../../src/inference/context-policy.js"
import { discoverOmlxModels, normalizeOmlxSettings, OmlxClient } from "../../src/inference/omlx.js"
import type { ChatMessage } from "../../src/inference/types.js"

const settings = { baseURL: "http://127.0.0.1:8000", apiKey: "test-private-key" }
afterEach(() => vi.unstubAllGlobals())

describe("oMLX", () => {
  it("uses visible IDs, resolves aliases and profiles, and excludes non-chat models", async () => {
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: `Bearer ${settings.apiKey}` })
      expect(init?.redirect).toBe("error")
      if (String(url).endsWith("/v1/models"))
        return Response.json({
          data: [
            { id: "vision-alias", max_model_len: 32768 },
            { id: "profile", max_model_len: 16384 },
            { id: "embedding" },
            { id: "reranker" },
            { id: "audio" },
            { id: "vision-alias" },
            {},
          ],
        })
      expect(String(url)).toBe(`${settings.baseURL}/v1/models/status`)
      return Response.json({
        models: [
          { id: "physical", model_alias: "vision-alias", model_type: "vlm", model_context_length: 262144 },
          { id: "profile", model_type: "llm" },
          { id: "embedding", model_type: "embedding" },
          { id: "reranker", model_type: "reranker" },
          { id: "audio", model_type: "stt" },
          { id: "hidden", model_type: "llm" },
        ],
      })
    })
    const models = await discoverOmlxModels(settings, { fetch: fetch as typeof globalThis.fetch })
    expect(models).toEqual([
      {
        provider: "omlx",
        id: "vision-alias",
        displayName: "vision-alias",
        baseURL: settings.baseURL,
        contextLength: 32768,
        supportsImageInput: true,
      },
      {
        provider: "omlx",
        id: "profile",
        displayName: "profile",
        baseURL: settings.baseURL,
        contextLength: 16384,
        supportsImageInput: false,
      },
    ])
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(models)).not.toContain(settings.apiKey)
  })

  it("accepts older servers without status and never treats native context as a serving limit", async () => {
    const fetch = vi.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith("/status")
        ? new Response("not found", { status: 404 })
        : Response.json({ data: [{ id: "chat", max_model_len: -1, model_context_length: 262144 }] }),
    )
    const [model] = await discoverOmlxModels(settings, { fetch: fetch as typeof globalThis.fetch })
    expect(model).toMatchObject({ supportsImageInput: false })
    expect(model).not.toHaveProperty("contextLength")
    if (!model) throw new Error("missing model")
    expect(compactionContextLength(model)).toBe(65_536)
    expect(compactionContextLength({ provider: "omlx", contextLength: 4096 })).toBe(4096)
    expect(compactionContextLength({ provider: "pair", contextLength: 4096 })).toBe(65_536)
  })

  it("reports auth and malformed inventory without echoing credentials", async () => {
    await expect(
      discoverOmlxModels(settings, {
        fetch: vi.fn(async () => new Response(settings.apiKey, { status: 401 })) as never,
      }),
    ).rejects.toThrow("HTTP 401")
    await expect(
      discoverOmlxModels(settings, { fetch: vi.fn(async () => Response.json({ data: null })) as never }),
    ).rejects.toThrow("invalid model list")
    const controller = new AbortController()
    controller.abort()
    await expect(
      discoverOmlxModels(settings, {
        signal: controller.signal,
        fetch: vi.fn(async () => {
          controller.signal.throwIfAborted()
          return new Response()
        }) as never,
      }),
    ).rejects.toMatchObject({ name: "AbortError" })
  })

  it("normalizes loopback endpoints and rejects remote or credential-bearing URLs", () => {
    expect(normalizeOmlxSettings({ baseURL: " http://localhost:8000/v1/ ", apiKey: " key " })).toEqual({
      baseURL: "http://localhost:8000",
      apiKey: "key",
    })
    for (const baseURL of [
      "http://192.168.1.2:8000",
      "http://localhost:8000/v1/models",
      "http://secret@localhost:8000",
      "http://localhost:8000?key=secret",
    ]) {
      expect(() => normalizeOmlxSettings({ baseURL })).toThrow()
    }
  })

  it("redacts an echoed key from inference errors", async () => {
    const client = new OmlxClient({
      ...settings,
      model: "chat",
      fetch: vi.fn(async () => new Response(`Invalid key: ${settings.apiKey}`, { status: 401 })) as never,
    })
    await expect(client.complete([{ role: "user", content: "hello" }])).rejects.toThrow("Invalid key: [redacted]")
  })

  it("streams tools and reasoning and replays provider-native history with credentials only in headers", async () => {
    const fetch = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          [
            'data: {"choices":[{"delta":{"reasoning_content":"Inspect the file."}}]}',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"read_1","function":{"name":"read","arguments":"{\\"path\\":\\"README.md\\"}"}}]}}]}',
            'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120}}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
        ),
    )
    const client = new OmlxClient({ ...settings, model: "chat", fetch: fetch as typeof globalThis.fetch })
    const messages: ChatMessage[] = [{ role: "user", content: "Read it." }]
    const events = []
    for await (const event of client.streamChat({
      messages,
      tools: [{ name: "read", description: "Read", parameters: { type: "object" } }],
    }))
      events.push(event)
    expect(events).toContainEqual({ type: "reasoning_delta", field: "reasoning_content", text: "Inspect the file." })
    expect(events).toContainEqual({
      type: "tool_call",
      toolCall: { id: "read_1", name: "read", arguments: '{"path":"README.md"}' },
    })
    expect(events).toContainEqual({
      type: "usage",
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    })
    messages.push(
      {
        role: "assistant",
        content: [
          { type: "reasoning", field: "reasoning_content", text: "Inspect the file." },
          { type: "tool_call", toolCall: { id: "read_1", name: "read", arguments: '{"path":"README.md"}' } },
        ],
      },
      { role: "tool", toolCallId: "read_1", content: "File contents" },
    )
    await client.complete(messages)
    const call = fetch.mock.calls[1]
    if (!call) throw new Error("missing second request")
    const [url, init] = call
    expect(url).toBe(`${settings.baseURL}/v1/chat/completions`)
    expect(init?.headers).toMatchObject({ authorization: `Bearer ${settings.apiKey}` })
    const body = JSON.parse(String(init?.body))
    expect(body.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          reasoning_content: "Inspect the file.",
          tool_calls: [expect.objectContaining({ id: "read_1" })],
        }),
        expect.objectContaining({ role: "tool", tool_call_id: "read_1" }),
      ]),
    )
    expect(body).not.toHaveProperty("reasoning_effort")
    expect(body).not.toHaveProperty("chat_template_kwargs")
    expect(String(init?.body)).not.toContain(settings.apiKey)
  })
})
