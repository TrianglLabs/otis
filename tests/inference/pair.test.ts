import { describe, expect, it, vi } from "vitest"
import { compactionContextLength } from "../../src/inference/context-policy.js"
import {
  discoverPairModels,
  normalizePairBaseURL,
  normalizePairEndpoints,
  PAIR_DEFAULT_ENDPOINTS,
  PairClient,
  pairEndpointForEngine,
  pairEngineLabel,
  pairModelKey,
} from "../../src/inference/pair.js"

describe("NVIDIA PAIR inference", () => {
  it("discovers each configured engine from its cluster inventory", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === "http://127.0.0.1:11434/api/tags") {
        return Response.json({
          models: [
            {
              name: "qwen3.8:latest",
              model: "qwen3.8:latest",
              details: {
                format: "gguf",
                family: "qwen35",
                parameter_size: "27.3B",
                quantization_level: "Q4_K_M",
                context_length: 262_144,
              },
              capabilities: ["completion", "tools", "thinking", "vision"],
            },
            { name: "qwen3.8:latest" },
            { name: "embedding-only", capabilities: ["embedding"] },
          ],
        })
      }
      if (url === "http://127.0.0.1:1234/v1/models") {
        return Response.json({
          object: "list",
          data: [
            { id: "google/gemma-4-26b-a4b@q4_k_m", object: "model" },
            { id: "text-embedding-nomic-embed-text-v1.5", object: "model", owned_by: "nomic-ai" },
            { id: "google/gemma-4-26b-a4b@q4_k_m" },
          ],
        })
      }
      throw new Error(`unexpected PAIR request: ${url}`)
    })

    const discovery = await discoverPairModels(
      { ollama: "http://127.0.0.1:11434/v1", lmStudio: "http://127.0.0.1:1234" },
      { fetch: fetchMock as typeof fetch },
    )

    expect(discovery).toEqual({
      ollama: [
        {
          provider: "pair",
          id: "qwen3.8:latest",
          displayName: "qwen3.8:latest",
          baseURL: "http://127.0.0.1:11434",
          engine: "ollama",
          nativeContextLength: 262_144,
          quantization: "Q4_K_M",
          supportsImageInput: true,
        },
      ],
      lmStudio: [
        {
          provider: "pair",
          id: "google/gemma-4-26b-a4b@q4_k_m",
          displayName: "gemma 4 26b a4b@q4 k m",
          baseURL: "http://127.0.0.1:1234",
          engine: "lmstudio",
          supportsImageInput: false,
        },
        {
          provider: "pair",
          id: "text-embedding-nomic-embed-text-v1.5",
          displayName: "text embedding nomic embed text v1.5",
          baseURL: "http://127.0.0.1:1234",
          engine: "lmstudio",
          supportsImageInput: false,
        },
      ],
      errors: [],
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("keeps one reachable engine when the other endpoint fails", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/tags")) return Response.json({ models: [{ name: "ollama-model" }] })
      return new Response("offline", { status: 503 })
    })

    const result = await discoverPairModels(PAIR_DEFAULT_ENDPOINTS, { fetch: fetchMock as typeof fetch })

    expect(result.ollama?.[0]?.id).toBe("ollama-model")
    expect(result.lmStudio).toBeUndefined()
    expect(result.errors).toEqual([expect.objectContaining({ engine: "lmstudio", baseURL: "http://127.0.0.1:1234" })])
  })

  it("reports an invalid inventory against the configured engine", async () => {
    const result = await discoverPairModels(
      { lmStudio: "http://127.0.0.1:1234" },
      { fetch: vi.fn(async () => Response.json({ models: [] })) as typeof fetch },
    )

    expect(result.lmStudio).toBeUndefined()
    expect(result.errors[0]?.engine).toBe("lmstudio")
    expect(result.errors[0]?.error.message).toContain("invalid LM Studio model list")
  })

  it("sends normal Otis tool calls through the PAIR chat endpoint", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          [
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"path\\":\\"README.md\\"}"}}]}}]}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
          { headers: { "content-type": "text/event-stream" } },
        ),
    )
    const client = new PairClient({
      model: "qwen3.5:35b",
      baseURL: "http://localhost:1234",
      fetch: fetchMock as typeof fetch,
    })

    const events = []
    for await (const event of client.streamChat({
      messages: [{ role: "user", content: "Read the README." }],
      tools: [
        {
          name: "read",
          description: "Read a file.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
          },
        },
      ],
    })) {
      events.push(event)
    }

    expect(events).toEqual([
      { type: "tool_call", toolCall: { id: "call_1", name: "read", arguments: '{"path":"README.md"}' } },
    ])
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://localhost:1234/v1/chat/completions")
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body.model).toBe("qwen3.5:35b")
    expect(body.tools[0].function.name).toBe("read")
    expect(body).not.toHaveProperty("reasoning_effort")
    expect(body).not.toHaveProperty("service_tier")
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty("authorization")
  })

  it("accepts only loopback PAIR base URLs", () => {
    expect(normalizePairBaseURL(" http://localhost:11434/v1 ")).toBe("http://localhost:11434")
    expect(normalizePairBaseURL("http://[::1]:1234")).toBe("http://[::1]:1234")
    expect(() => normalizePairBaseURL("http://192.168.1.5:11434")).toThrow("must use HTTP")
    expect(() => normalizePairBaseURL("https://localhost:11434")).toThrow("must use HTTP")
    expect(() => normalizePairBaseURL("http://localhost:11434/v1/models")).toThrow("base URL shown in PAIR")
    expect(() => normalizePairBaseURL("http://localhost:11434/v1/chat/completions")).toThrow("base URL shown in PAIR")
  })

  it("normalizes engine-specific endpoints and rejects one proxy in both fields", () => {
    expect(
      normalizePairEndpoints({
        ollama: " http://localhost:11434/v1 ",
        lmStudio: "http://127.0.0.1:1234",
      }),
    ).toEqual({
      ollama: "http://localhost:11434",
      lmStudio: "http://127.0.0.1:1234",
    })
    expect(() =>
      normalizePairEndpoints({
        ollama: "http://localhost:11434",
        lmStudio: "http://localhost:11434/v1",
      }),
    ).toThrow("must be different")
  })

  it("resolves endpoint, label, and identity from the selected engine", () => {
    const endpoints = { ollama: "http://localhost:11434", lmStudio: "http://localhost:1234" }
    expect(pairEndpointForEngine(endpoints, "lmstudio")).toBe("http://localhost:1234")
    expect(pairEngineLabel("lmstudio")).toBe("LM Studio")
    expect(pairModelKey({ engine: "ollama", id: "model" })).not.toBe(pairModelKey({ engine: "lmstudio", id: "model" }))
  })

  it("uses the PAIR context fallback only as a compaction policy", () => {
    expect(compactionContextLength({ provider: "pair", contextLength: 262_144 })).toBe(65_536)
    expect(compactionContextLength({ provider: "local", contextLength: 131_072 })).toBe(131_072)
  })
})
