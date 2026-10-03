import { afterEach, describe, expect, it, vi } from "vitest"
import { listHostedModels } from "../../src/inference/catalog.js"
import { HOSTED_PROVIDER_INFO, HOSTED_PROVIDERS } from "../../src/inference/types.js"

afterEach(() => vi.restoreAllMocks())

describe("listHostedModels for Fireworks", () => {
  it("paginates the public catalog and returns only serverless models with tool support", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith("/inference/v1/models")) return Response.json({ data: [] })
      if (url.searchParams.get("pageToken") === "page-two") {
        return Response.json({
          models: [model("accounts/fireworks/models/alpha", "Alpha", true, true)],
        })
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

    const models = await listHostedModels("fireworks", "fw_test_key", {
      fetch: fetchMock as typeof fetch,
      modelsURL: "http://localhost/v1/accounts/fireworks/models",
      inferenceModelsURL: "http://localhost/inference/v1/models",
    })

    expect(models).toEqual([
      {
        provider: "fireworks",
        id: "accounts/fireworks/models/alpha",
        displayName: "Alpha",
        supportsImageInput: false,
      },
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
    expect(catalogURLs[0].searchParams.get("filter")).toBe(
      "supports_serverless=true AND supports_tools=true",
    )
    expect(catalogURLs[0].searchParams.get("pageSize")).toBe("200")
    expect(catalogURLs[1].searchParams.get("pageToken")).toBe("page-two")
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toContain(
      "http://localhost/inference/v1/models",
    )
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
        models: [
          model("accounts/fireworks/models/kimi-k3", "Kimi K3", true, true, 1_048_576, true),
        ],
      })
    })

    const models = await listHostedModels("fireworks", "fw_test_key", {
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
      if (String(input).includes("/inference/v1/models"))
        return new Response("unavailable", { status: 503 })
      return Response.json({
        models: [model("accounts/fireworks/models/kimi-k3", "Kimi K3", true, true)],
      })
    })

    await expect(
      listHostedModels("fireworks", "fw_test_key", {
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
      listHostedModels("fireworks", "fw_test_key", {
        fetch: fetchMock as typeof fetch,
        modelsURL: "http://localhost/models",
      }),
    ).rejects.toThrow("Fireworks models response was invalid.")
  })
})

describe("listHostedModels for Together AI", () => {
  it("keeps only documented function-calling chat models from the bare array", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json([
        together("moonshotai/Kimi-K3", "chat", "Kimi K3", 262_144),
        together("Qwen/Qwen2.5-7B-Instruct-Turbo", "chat", "Qwen 2.5 7B Turbo", 32_768),
        together("zai-org/GLM-5.3", "language", "GLM 5.3 base", 131_072),
        together("zai-org/GLM-5.3-Flash", "chat", "GLM 5.3 Flash", 131_072),
        together("deepseek-ai/DeepSeek-V4.1-Flash", "chat", "DeepSeek V4.1 Flash", 128_000),
        together("deepseek-ai/DeepSeek-V4.1-Flash", "chat", "DeepSeek V4.1 Flash", 128_000),
        together("openai/gpt-oss-120b", "chat", null, 131_072),
        { type: "chat", display_name: "No id" },
        "not a row",
      ]),
    )

    const models = await listHostedModels("together", " tg_test_key ", {
      fetch: fetchMock as typeof fetch,
      modelsURL: "http://localhost/v1/models",
    })

    expect(models).toEqual([
      {
        provider: "together",
        id: "deepseek-ai/DeepSeek-V4.1-Flash",
        displayName: "DeepSeek V4.1 Flash",
        contextLength: 128_000,
        supportsImageInput: true,
      },
      {
        provider: "together",
        id: "zai-org/GLM-5.3-Flash",
        displayName: "GLM 5.3 Flash",
        contextLength: 131_072,
        supportsImageInput: true,
      },
      {
        provider: "together",
        id: "openai/gpt-oss-120b",
        displayName: "gpt-oss-120b",
        contextLength: 131_072,
        supportsImageInput: false,
      },
      {
        provider: "together",
        id: "moonshotai/Kimi-K3",
        displayName: "Kimi K3",
        contextLength: 262_144,
        supportsImageInput: true,
      },
    ])
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://localhost/v1/models")
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({ authorization: "Bearer tg_test_key" })
  })

  it("calls the documented models endpoint by default", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => Response.json([]))
    await expect(
      listHostedModels("together", "tg_test_key", { fetch: fetchMock as typeof fetch }),
    ).resolves.toEqual([])
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.together.xyz/v1/models")
  })

  it("rejects an envelope that is not a list", async () => {
    const fetchMock = vi.fn(async () => Response.json({ models: [] }))
    await expect(
      listHostedModels("together", "tg_test_key", {
        fetch: fetchMock as typeof fetch,
        modelsURL: "http://localhost/v1/models",
      }),
    ).rejects.toThrow("Together AI models response was invalid.")
  })
})

describe("listHostedModels for Baseten", () => {
  it("keeps every Model API row and reads vision from supported features", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        data: [
          {
            id: "moonshotai/Kimi-K2.5",
            name: "Kimi K2.5",
            context_length: 262_144,
            max_completion_tokens: 32_768,
            supported_features: ["vision", "reasoning", "reasoning_effort"],
            pricing: { input: 0.6, output: 2.5 },
          },
          {
            id: "deepseek-ai/DeepSeek-V3.2",
            name: "DeepSeek V3.2",
            context_length: 163_840,
            max_completion_tokens: 32_768,
            supported_features: ["reasoning"],
            pricing: { input: 0.3, output: 0.5 },
          },
          {
            id: "zai-org/GLM-5",
            name: "GLM 5",
            context_length: 0,
            supported_features: [],
          },
          { id: "zai-org/GLM-5", name: "GLM 5 duplicate", context_length: 10 },
        ],
      }),
    )

    const models = await listHostedModels("baseten", "bt_test_key", {
      fetch: fetchMock as typeof fetch,
      modelsURL: "http://localhost/v1/models",
    })

    expect(models).toEqual([
      {
        provider: "baseten",
        id: "deepseek-ai/DeepSeek-V3.2",
        displayName: "DeepSeek V3.2",
        contextLength: 163_840,
        supportsImageInput: false,
      },
      { provider: "baseten", id: "zai-org/GLM-5", displayName: "GLM 5", supportsImageInput: false },
      {
        provider: "baseten",
        id: "moonshotai/Kimi-K2.5",
        displayName: "Kimi K2.5",
        contextLength: 262_144,
        supportsImageInput: true,
      },
    ])
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({ authorization: "Bearer bt_test_key" })
  })

  it("calls the documented models endpoint by default", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => Response.json({ data: [] }))
    await expect(
      listHostedModels("baseten", "bt_test_key", { fetch: fetchMock as typeof fetch }),
    ).resolves.toEqual([])
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://inference.baseten.co/v1/models")
  })

  it("rejects a body without a data list", async () => {
    const fetchMock = vi.fn(async () => Response.json({ data: { id: "x" } }))
    await expect(
      listHostedModels("baseten", "bt_test_key", {
        fetch: fetchMock as typeof fetch,
        modelsURL: "http://localhost/v1/models",
      }),
    ).rejects.toThrow("Baseten models response was invalid.")
  })
})

describe("listHostedModels for Prime Intellect", () => {
  it("keeps rows that support tools, reads vision from input modalities, and names unnamed ids", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        data: [
          {
            id: "moonshotai/kimi-k2.5",
            display_name: "Kimi K2.5",
            context_window: 262_144,
            specs: { modalities: { input: ["text", "image"] } },
            supported_parameters: ["tools", "reasoning"],
          },
          {
            id: "deepseek-ai/deepseek-v3.2",
            display_name: null,
            context_window: 163_840,
            specs: { modalities: { input: ["text"] } },
            supported_parameters: ["tools"],
          },
          {
            id: "meta-llama/llama-3-8b",
            display_name: "Llama 3 8B",
            context_window: 8_192,
            specs: { modalities: { input: ["text"] } },
            supported_parameters: ["temperature"],
          },
          {
            id: "openai/gpt-oss-120b",
            display_name: "gpt-oss 120B",
            context_window: 131_072,
            specs: {},
          },
        ],
      }),
    )

    const models = await listHostedModels("primeintellect", "pi_test_key", {
      fetch: fetchMock as typeof fetch,
      modelsURL: "http://localhost/api/v1/models",
    })

    expect(models).toEqual([
      {
        provider: "primeintellect",
        id: "deepseek-ai/deepseek-v3.2",
        displayName: "deepseek-v3.2",
        contextLength: 163_840,
        supportsImageInput: false,
      },
      {
        provider: "primeintellect",
        id: "moonshotai/kimi-k2.5",
        displayName: "Kimi K2.5",
        contextLength: 262_144,
        supportsImageInput: true,
      },
    ])
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({ authorization: "Bearer pi_test_key" })
  })

  it("calls the documented models endpoint by default", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => Response.json({ data: [] }))
    await expect(
      listHostedModels("primeintellect", "pi_test_key", { fetch: fetchMock as typeof fetch }),
    ).resolves.toEqual([])
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.pinference.ai/api/v1/models")
  })

  it("rejects a body without a data list", async () => {
    const fetchMock = vi.fn(async () => Response.json([]))
    // A bare array is Together's shape; Prime Intellect's envelope must carry `data`.
    await expect(
      listHostedModels("primeintellect", "pi_test_key", {
        fetch: fetchMock as typeof fetch,
        modelsURL: "http://localhost/api/v1/models",
      }),
    ).resolves.toEqual([])
    const invalid = vi.fn(async () => Response.json({ models: [] }))
    await expect(
      listHostedModels("primeintellect", "pi_test_key", {
        fetch: invalid as typeof fetch,
        modelsURL: "http://localhost/api/v1/models",
      }),
    ).rejects.toThrow("Prime Intellect models response was invalid.")
  })
})

describe("listHostedModels for every provider", () => {
  it.each(HOSTED_PROVIDERS)("requires a %s key before any request", async (provider) => {
    const fetchMock = vi.fn()
    await expect(
      listHostedModels(provider, "  ", { fetch: fetchMock as typeof fetch }),
    ).rejects.toThrow(`${HOSTED_PROVIDER_INFO[provider].name} API key is required.`)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(HOSTED_PROVIDERS)("names %s in a rejected key error", async (provider) => {
    const fetchMock = vi.fn(async () =>
      Response.json({ error: { message: "Invalid API key" } }, { status: 401 }),
    )
    await expect(
      listHostedModels(provider, "bad_key", {
        fetch: fetchMock as typeof fetch,
        modelsURL: "http://localhost/models",
        inferenceModelsURL: "http://localhost/inference/models",
      }),
    ).rejects.toThrow(
      `${HOSTED_PROVIDER_INFO[provider].name} rejected the API key: Invalid API key.`,
    )
  })

  it.each(HOSTED_PROVIDERS)("reports a %s outage instead of an empty catalog", async (provider) => {
    const fetchMock = vi.fn(async () => new Response("down", { status: 503 }))
    await expect(
      listHostedModels(provider, "key", {
        fetch: fetchMock as typeof fetch,
        modelsURL: "http://localhost/models",
        inferenceModelsURL: "http://localhost/inference/models",
      }),
    ).rejects.toThrow(`${HOSTED_PROVIDER_INFO[provider].name} is unavailable right now (HTTP 503)`)
  })

  it("rejects a non-HTTPS models URL outside local tests", async () => {
    await expect(
      listHostedModels("together", "key", { modelsURL: "http://example.com/models" }),
    ).rejects.toThrow("must use HTTPS")
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

function together(id: string, type: string, display_name: string | null, context_length: number) {
  return { id, object: "model", type, display_name, context_length, organization: id.split("/")[0] }
}
