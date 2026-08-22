import { describe, expect, it, vi } from "vitest"
import { ParallelClient } from "../../src/web/client.js"

describe("ParallelClient", () => {
  it("calls Search MCP without auth and maps provider context onto the JSON-RPC tool call", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      mcpResponse({
        search_id: "search_1",
        session_id: "session_1",
        results: [
          {
            url: "https://example.com/news",
            title: "Example news",
            publish_date: "2026-07-16",
            excerpts: ["Relevant result"],
          },
        ],
        warnings: [{ type: "warning", message: "Limited index coverage" }],
      }),
    )
    const client = new ParallelClient({
      url: "http://localhost:8787/mcp",
      fetch: fetchMock as typeof fetch,
    })

    await expect(
      client.search({
        objective: "Find current release information",
        searchQueries: ["current release", "release notes"],
        clientModel: "accounts/fireworks/models/tool-model",
        sessionId: "otis_session",
      }),
    ).resolves.toEqual({
      searchId: "search_1",
      sessionId: "session_1",
      results: [
        {
          url: "https://example.com/news",
          title: "Example news",
          publishDate: "2026-07-16",
          excerpts: ["Relevant result"],
        },
      ],
      warnings: ["Limited index coverage"],
    })

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe("http://localhost:8787/mcp")
    expect(init?.headers).toMatchObject({
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    })
    expect(init?.headers).not.toHaveProperty("authorization")
    expect(init?.headers).not.toHaveProperty("x-api-key")
    expect(JSON.parse(String(init?.body))).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "web_search",
        arguments: {
          objective: "Find current release information",
          search_queries: ["current release", "release notes"],
          model_name: "accounts/fireworks/models/tool-model",
          session_id: "otis_session",
        },
      },
    })
  })

  it("maps web_read onto web_fetch and unwraps SSE MCP payloads", async () => {
    const fetchMock = mockFetch(() =>
      mcpSseResponse({
        extract_id: "extract_1",
        session_id: "session_1",
        results: [
          {
            url: "https://example.com/docs",
            title: "Docs",
            excerpts: ["Relevant excerpt"],
          },
        ],
        errors: [
          {
            url: "https://example.com/missing",
            error_type: "NOT_FOUND",
            http_status_code: 404,
            content: "Missing",
          },
        ],
      }),
    )
    const client = new ParallelClient({
      url: "http://localhost:8787/mcp",
      fetch: fetchMock as typeof fetch,
    })

    const response = await client.read({ url: "https://example.com/docs", objective: "Read API limits" })

    expect(response.results[0]).toEqual({
      url: "https://example.com/docs",
      title: "Docs",
      excerpts: ["Relevant excerpt"],
    })
    expect(response.errors[0]).toEqual({
      url: "https://example.com/missing",
      type: "NOT_FOUND",
      status: 404,
      content: "Missing",
    })
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "web_fetch",
        arguments: {
          urls: ["https://example.com/docs"],
          objective: "Read API limits",
        },
      },
    })
  })

  it("truncates session ids to Parallel's MCP limit", async () => {
    const fetchMock = mockFetch(() =>
      mcpResponse({
        search_id: "search_1",
        session_id: "session_1",
        results: [],
      }),
    )
    const client = new ParallelClient({
      url: "http://localhost:8787/mcp",
      fetch: fetchMock as typeof fetch,
    })
    const sessionId = `session_${"a".repeat(120)}`

    await client.search({ objective: "Find docs", searchQueries: ["docs"], sessionId })

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).params.arguments.session_id).toBe(
      sessionId.slice(0, 100),
    )
  })

  it("uses the public Search MCP endpoint by default", async () => {
    const fetchMock = mockFetch(() =>
      mcpResponse({
        search_id: "search_1",
        session_id: "session_1",
        results: [],
      }),
    )
    const client = new ParallelClient({ fetch: fetchMock as typeof fetch })

    await client.search({ objective: "Find docs", searchQueries: ["docs"] })

    expect(String(fetchMock.mock.calls[0][0])).toBe("https://search.parallel.ai/mcp")
  })

  it("surfaces HTTP, JSON-RPC, and insecure endpoint failures", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("invalid key", { status: 401 }),
    )
    const client = new ParallelClient({
      url: "http://localhost:8787/mcp",
      fetch: fetchMock as typeof fetch,
    })

    await expect(client.search({ objective: "Find docs", searchQueries: ["docs"] })).rejects.toThrow(
      "Parallel request failed with HTTP 401: invalid key",
    )

    fetchMock.mockResolvedValueOnce(
      Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "quota exceeded" } }),
    )
    await expect(client.search({ objective: "Find docs", searchQueries: ["docs"] })).rejects.toThrow("quota exceeded")

    expect(() => new ParallelClient({ url: "http://example.com/mcp" })).toThrow("must use HTTPS")
  })
})

function mockFetch(response: () => Response) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response())
}

function mcpResponse(payload: unknown) {
  return Response.json({
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [{ type: "text", text: JSON.stringify(payload) }],
    },
  })
}

function mcpSseResponse(payload: unknown) {
  return new Response(
    `data: ${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
    })}\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  )
}
