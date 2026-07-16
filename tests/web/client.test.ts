import { describe, expect, it, vi } from "vitest"
import { ParallelClient } from "../../src/web/client.js"

describe("ParallelClient", () => {
  it("sends direct search requests with the user key and provider context", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
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
      apiKey: "parallel_test_key",
      baseURL: "http://localhost:8787",
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
    expect(String(url)).toBe("http://localhost:8787/v1/search")
    expect(init?.headers).toMatchObject({ "x-api-key": "parallel_test_key" })
    expect(JSON.parse(String(init?.body))).toEqual({
      objective: "Find current release information",
      search_queries: ["current release", "release notes"],
      mode: "basic",
      max_chars_total: 16_000,
      client_model: "accounts/fireworks/models/tool-model",
      session_id: "otis_session",
    })
  })

  it("extracts a known URL and preserves provider errors", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        extract_id: "extract_1",
        session_id: "session_1",
        results: [
          {
            url: "https://example.com/docs",
            title: "Docs",
            excerpts: ["Relevant excerpt"],
            full_content: "Full page content",
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
      apiKey: "parallel_test_key",
      baseURL: "http://localhost:8787",
      fetch: fetchMock as typeof fetch,
    })

    const response = await client.read({ url: "https://example.com/docs", objective: "Read API limits" })

    expect(response.results[0]).toEqual({
      url: "https://example.com/docs",
      title: "Docs",
      excerpts: ["Relevant excerpt"],
      fullContent: "Full page content",
    })
    expect(response.errors[0]).toEqual({
      url: "https://example.com/missing",
      type: "NOT_FOUND",
      status: 404,
      content: "Missing",
    })
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      urls: ["https://example.com/docs"],
      objective: "Read API limits",
      max_chars_total: 16_000,
      advanced_settings: { full_content: { max_chars_per_result: 16_000 } },
    })
  })

  it("surfaces provider failures and rejects insecure provider URLs", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("invalid key", { status: 401 }),
    )
    const client = new ParallelClient({
      apiKey: "parallel_test_key",
      baseURL: "http://localhost:8787",
      fetch: fetchMock as typeof fetch,
    })

    await expect(client.search({ objective: "Find docs", searchQueries: ["docs"] })).rejects.toThrow(
      "Parallel request failed with HTTP 401: invalid key",
    )
    expect(() => new ParallelClient({ apiKey: "key", baseURL: "http://example.com" })).toThrow("must use HTTPS")
  })
})
