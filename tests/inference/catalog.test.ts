import { afterEach, describe, expect, it, vi } from "vitest"
import { listToolCapableModels } from "../../src/inference/catalog.js"

afterEach(() => vi.restoreAllMocks())

describe("listToolCapableModels", () => {
  it("paginates the public catalog and returns only serverless models with tool support", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith("/inference/v1/models")) return Response.json({ data: [] })
      if (url.searchParams.get("pageToken") === "page-two") {
        return Response.json({ models: [model("accounts/fireworks/models/alpha", "Alpha", true, true)] })
      }
      return Response.json({
        models: [
          model("accounts/fireworks/models/zeta", "Zeta", true, true, 128_000, true),
          model("accounts/fireworks/models/chat-only", "Chat only", true, false),
          model("accounts/fireworks/models/deployed", "Deployed", false, true),
        ],
        nextPageToken: "page-two",
      })
    })

    const models = await listToolCapableModels("fw_test_key", {
      fetch: fetchMock as typeof fetch,
      modelsURL: "http://localhost/v1/accounts/fireworks/models",
      inferenceModelsURL: "http://localhost/inference/v1/models",
    })

    expect(models).toEqual([
      { provider: "fireworks", id: "accounts/fireworks/models/alpha", displayName: "Alpha", supportsImageInput: false },
      {
        provider: "fireworks",
        id: "accounts/fireworks/models/zeta",
        displayName: "Zeta",
        contextLength: 128_000,
        supportsImageInput: true,
      },
    ])
    const catalogURLs = fetchMock.mock.calls
      .map(([input]) => new URL(String(input)))
      .filter((url) => url.pathname.endsWith("/v1/accounts/fireworks/models"))
    expect(catalogURLs).toHaveLength(2)
    expect(catalogURLs[0].searchParams.get("filter")).toBe("supports_serverless=true AND supports_tools=true")
    expect(catalogURLs[0].searchParams.get("pageSize")).toBe("200")
    expect(catalogURLs[1].searchParams.get("pageToken")).toBe("page-two")
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toContain("http://localhost/inference/v1/models")
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({ authorization: "Bearer fw_test_key" })
  })

  it("marks matching catalog models with their Fast serving path", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/inference/v1/models")) {
        return Response.json({
          data: [
            { id: "accounts/fireworks/routers/kimi-k3-fast", supports_tools: true },
            { id: "accounts/fireworks/routers/kimi-k2p6-turbo", supports_tools: true },
            { id: "accounts/fireworks/routers/orphan-fast", supports_tools: true },
            { id: "accounts/fireworks/routers/glm-5p2-fast", supports_tools: false },
          ],
        })
      }
      return Response.json({
        models: [model("accounts/fireworks/models/kimi-k3", "Kimi K3", true, true, 1_048_576, true)],
      })
    })

    const models = await listToolCapableModels("fw_test_key", {
      fetch: fetchMock as typeof fetch,
      modelsURL: "http://localhost/v1/accounts/fireworks/models",
      inferenceModelsURL: "http://localhost/inference/v1/models",
    })

    expect(models).toEqual([
      {
        provider: "fireworks",
        id: "accounts/fireworks/models/kimi-k3",
        displayName: "Kimi K3",
        contextLength: 1_048_576,
        supportsImageInput: true,
        fastId: "accounts/fireworks/routers/kimi-k3-fast",
      },
    ])
  })

  it("keeps the serverless catalog when Fast serving paths cannot be listed", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/inference/v1/models")) return new Response("unavailable", { status: 503 })
      return Response.json({
        models: [model("accounts/fireworks/models/kimi-k3", "Kimi K3", true, true)],
      })
    })

    await expect(
      listToolCapableModels("fw_test_key", {
        fetch: fetchMock as typeof fetch,
        modelsURL: "http://localhost/v1/accounts/fireworks/models",
        inferenceModelsURL: "http://localhost/inference/v1/models",
      }),
    ).resolves.toEqual([
      {
        provider: "fireworks",
        id: "accounts/fireworks/models/kimi-k3",
        displayName: "Kimi K3",
        supportsImageInput: false,
      },
    ])
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
  supportsImageInput = false,
) {
  return { name, displayName, supportsServerless, supportsTools, contextLength, supportsImageInput }
}
