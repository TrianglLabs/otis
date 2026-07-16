import { describe, expect, it, vi } from "vitest"
import { executeToolCall } from "../../src/tools/index.js"
import type { ParallelClient } from "../../src/web/client.js"

describe("web tools", () => {
  it("formats direct Parallel search results as bounded tool context", async () => {
    const search = vi.fn(async () => ({
      searchId: "search_1",
      sessionId: "parallel_session",
      results: [
        {
          url: "https://example.com/release",
          title: "Release notes",
          publishDate: "2026-07-16",
          excerpts: ["Version 2 is available."],
        },
      ],
      warnings: [],
    }))
    const webClient = { search, read: vi.fn() } as unknown as ParallelClient
    const webSession = {}

    const result = await executeToolCall(
      {
        name: "web_search",
        input: { objective: "Find the latest release", searchQueries: ["latest release", "release notes"] },
      },
      { webClient, webClientModel: "tool-model", webSession },
    )

    expect(search).toHaveBeenCalledWith({
      objective: "Find the latest release",
      searchQueries: ["latest release", "release notes"],
      clientModel: "tool-model",
      sessionId: undefined,
      signal: undefined,
    })
    expect(webSession).toEqual({ id: "parallel_session" })
    expect(result.output).toContain("Release notes")
    expect(result.output).toContain("https://example.com/release · 2026-07-16")
    expect(result.output).toContain("Version 2 is available.")
  })

  it("uses full extracted content and reports extraction failures", async () => {
    const read = vi.fn(async () => ({
      extractId: "extract_1",
      sessionId: "parallel_session",
      results: [{ url: "https://example.com/docs", title: "Docs", excerpts: ["Excerpt"], fullContent: "Full docs" }],
      errors: [{ url: "https://example.com/missing", type: "NOT_FOUND", status: 404 }],
      warnings: ["One URL failed"],
    }))
    const webClient = { search: vi.fn(), read } as unknown as ParallelClient
    const webSession = { id: "search_session" }

    const result = await executeToolCall(
      { name: "web_read", input: { url: "https://example.com/docs", objective: "Read docs" } },
      { webClient, webSession },
    )

    expect(read).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "search_session" }))
    expect(webSession.id).toBe("parallel_session")
    expect(result.output).toContain("Full docs")
    expect(result.output).not.toContain("Excerpt")
    expect(result.output).toContain("Could not read https://example.com/missing: NOT_FOUND (HTTP 404)")
    expect(result.output).toContain("Warnings:\n- One URL failed")
  })

  it("fails clearly when no Parallel key is configured", async () => {
    await expect(executeToolCall({ name: "web_read", input: { url: "https://example.com" } })).rejects.toThrow(
      "Parallel API key is not configured",
    )
  })
})
