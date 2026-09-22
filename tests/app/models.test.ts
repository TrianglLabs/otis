import { beforeEach, describe, expect, it, vi } from "vitest"
import { ModelHost } from "../../src/app/models.js"
import { autoCompactThreshold } from "../../src/core/compaction.js"
import { compactionContextLength } from "../../src/inference/context-policy.js"
import type { LlamaCppRuntime } from "../../src/inference/llama-runtime.js"
import type { FireworksModel, OmlxCatalogModel } from "../../src/inference/types.js"
import type { LocalSettings } from "../../src/local/settings.js"

const mocks = vi.hoisted(() => ({ listToolCapableModels: vi.fn() }))
vi.mock("../../src/inference/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/inference/client.js")>()),
  listToolCapableModels: mocks.listToolCapableModels,
}))
beforeEach(() => {
  mocks.listToolCapableModels.mockReset()
})

const hosted: FireworksModel = {
  provider: "fireworks",
  id: "accounts/fireworks/models/example",
  displayName: "example",
  supportsImageInput: false,
}

describe("ModelHost", () => {
  it.each([
    8192, 32768, 65535,
  ])("rejects an oMLX serving limit of %i before stopping or persisting the previous model", async (contextLength) => {
    const llama = fakeLlama()
    const host = new ModelHost({ llama })
    host.applySavedSelection({
      model: hosted.id,
      modelProvider: "fireworks",
      fireworksApiKey: "test-key",
    })
    const previous = host.client
    host.omlx = { baseURL: "http://127.0.0.1:8000" }
    const model: OmlxCatalogModel = {
      provider: "omlx",
      id: "chat",
      displayName: "Chat",
      baseURL: host.omlx.baseURL,
      supportsImageInput: false,
      contextLength,
    }
    const persist = vi.fn()
    await expect(
      host.persistSelection(model, { signal: new AbortController().signal, persist }),
    ).rejects.toThrow("at least 65,536 tokens (64K)")
    expect(llama.stop).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()
    expect(host.client).toBe(previous)
    expect(host.selectedId).toBe(hosted.id)
  })

  it.each([
    undefined,
    65536,
    131072,
  ])("uses the minimum policy or reported oMLX serving context: %s", async (contextLength) => {
    const host = new ModelHost({ llama: fakeLlama() })
    host.omlx = { baseURL: "http://127.0.0.1:8000" }
    const model: OmlxCatalogModel = {
      provider: "omlx",
      id: "chat",
      displayName: "Chat",
      baseURL: host.omlx.baseURL,
      supportsImageInput: false,
      ...(contextLength ? { contextLength } : {}),
    }
    const persist = vi.fn()
    await host.persistSelection(model, { signal: new AbortController().signal, persist })
    expect(host.autoCompactAtTokens).toBe(autoCompactThreshold(contextLength ?? 65536))
    expect(persist).toHaveBeenCalledWith(model)
    // The fallback remains policy only; it is not invented server metadata.
    if (contextLength === undefined)
      expect(persist.mock.calls[0][0]).not.toHaveProperty("contextLength")
  })

  it.each([
    "ollama",
    "lmstudio",
  ] as const)("restores %s without token configuration or trusting legacy architecture context", async (engine) => {
    const llama = fakeLlama()
    const host = new ModelHost({ llama })
    const endpoint = engine === "ollama" ? "http://127.0.0.1:11434" : "http://127.0.0.1:1234"
    host.applySavedSelection({
      model: "chat",
      modelProvider: "pair",
      pairEngine: engine,
      modelContextLength: 262144,
      pairEndpoints: engine === "ollama" ? { ollama: endpoint } : { lmStudio: endpoint },
    })
    expect(host.autoCompactAtTokens).toBe(autoCompactThreshold(65_536))
    expect(host.client?.model).toBe("chat")
    const connected = await host.connect({
      provider: "pair",
      modelId: "chat",
      pairEngine: engine,
      pairEndpoint: endpoint,
      contextLength: 262144,
    })
    expect(connected.contextLength).toBe(65_536)
    expect(host.autoCompactAtTokens).toBe(autoCompactThreshold(65_536))
    expect(llama.stop).toHaveBeenCalledOnce()
  })
  it("restores a hosted Fireworks selection without starting llama.cpp", () => {
    const host = new ModelHost()
    const settings: LocalSettings = {
      fireworksApiKey: "fw_test",
      model: "accounts/fireworks/models/example",
      modelProvider: "fireworks",
      modelContextLength: 128_000,
      modelSupportsImageInput: true,
    }

    host.applySavedSelection(settings)

    expect(host.selectedId).toBe(settings.model)
    expect(host.selectedProvider).toBe("fireworks")
    expect(host.supportsImageInput).toBe(true)
    expect(host.client?.model).toBe(settings.model)
    expect(host.autoCompactAtTokens).toBe(
      autoCompactThreshold(
        compactionContextLength({ provider: "fireworks", contextLength: 128_000 }),
      ),
    )
    expect(host.activeLocal).toBeUndefined()
  })

  it("refreshes a saved Fireworks window from the catalog only when the selection lacks it", async () => {
    mocks.listToolCapableModels.mockResolvedValue([{ ...hosted, contextLength: 131_072 }])
    const host = new ModelHost({ llama: fakeLlama() })
    const connected = await host.connect({
      provider: "fireworks",
      modelId: hosted.id,
      fireworksApiKey: "fw_test",
    })
    expect(connected.contextLength).toBe(131_072)
    expect(host.autoCompactAtTokens).toBe(autoCompactThreshold(131_072))
    expect(mocks.listToolCapableModels).toHaveBeenCalledOnce()

    await host.connect({
      provider: "fireworks",
      modelId: hosted.id,
      fireworksApiKey: "fw_test",
      contextLength: 65_536,
    })
    expect(host.autoCompactAtTokens).toBe(autoCompactThreshold(65_536))
    expect(mocks.listToolCapableModels).toHaveBeenCalledOnce()
  })

  it("budgets an unreachable catalog like a 128K model instead of failing the connection", async () => {
    mocks.listToolCapableModels.mockImplementation(async () => {
      throw new Error("offline")
    })
    const host = new ModelHost({ llama: fakeLlama() })
    const connected = await host.connect({
      provider: "fireworks",
      modelId: hosted.id,
      fireworksApiKey: "fw_test",
    })
    expect(connected.contextLength).toBeUndefined()
    expect(host.autoCompactAtTokens).toBe(autoCompactThreshold(131_072))
  })

  it("reserves more output for a high thinking effort at 64K and nothing extra at 128K", () => {
    const host = new ModelHost({ llama: fakeLlama() })
    host.applySavedSelection({
      model: "Qwen/Qwen3.8-27B",
      modelProvider: "local",
      modelContextLength: 65_536,
    })
    expect(host.autoCompactAtTokens).toBe(49_152)
    host.localThinking = { "Qwen/Qwen3.8-27B": "low" }
    host.refreshAutoCompact()
    expect(host.autoCompactAtTokens).toBe(52_428)
    host.localThinking = { "Qwen/Qwen3.8-27B": "xhigh" }
    host.refreshAutoCompact()
    expect(host.autoCompactAtTokens).toBe(49_152)

    host.applySavedSelection({
      model: "Qwen/Qwen3.8-27B",
      modelProvider: "local",
      modelContextLength: 131_072,
    })
    expect(host.autoCompactAtTokens).toBe(104_857)

    host.applySavedSelection({
      fireworksApiKey: "fw_test",
      model: "accounts/fireworks/models/deepseek-v4",
      modelProvider: "fireworks",
      modelContextLength: 65_536,
    })
    expect(host.autoCompactAtTokens).toBe(49_152)
    host.applySavedSelection({
      fireworksApiKey: "fw_test",
      model: "accounts/fireworks/models/llama-v3p1-70b-instruct",
      modelProvider: "fireworks",
      modelContextLength: 65_536,
    })
    expect(host.autoCompactAtTokens).toBe(52_428)
  })

  it("records a local selection without creating a client until serving starts", () => {
    const host = new ModelHost()
    host.applySavedSelection({
      model: "local/qwen",
      modelProvider: "local",
      modelContextLength: 65_536,
    })

    expect(host.selectedProvider).toBe("local")
    expect(host.client).toBeUndefined()
    expect(host.autoCompactAtTokens).toBe(autoCompactThreshold(65_536))
  })

  it.each([
    "prepare",
    "connect",
  ] as const)("relays a serving notice from %s to the adapter hook", async (path) => {
    const llama = fakeLlama()
    vi.mocked(llama.ensureServing).mockImplementation(
      async (
        spec: { id: string },
        _fit,
        _hardware,
        options?: { onNotice?: (m: string) => void },
      ) => {
        options?.onNotice?.("CUDA failed (no device); running on Vulkan.")
        return {
          model: spec.id,
          inferenceURL: "http://127.0.0.1:1/v1/chat/completions",
          contextLength: 65_536,
        }
      },
    )
    const host = new ModelHost({ llama })
    const notices: string[] = []
    host.onNotice = (message) => notices.push(message)
    const model = {
      provider: "local" as const,
      id: "openai/gpt-oss-20b",
      displayName: "gpt-oss",
      contextLength: 65_536,
      supportsImageInput: false,
    }
    if (path === "prepare") {
      const prepared = await host.prepare(model, { signal: new AbortController().signal })
      prepared.commit()
    } else await host.connect({ provider: "local", modelId: model.id })
    expect(notices).toEqual(["CUDA failed (no device); running on Vulkan."])
    expect(host.selectedId).toBe(model.id)
  })

  it("drops a notice from a superseded prepare", async () => {
    const llama = fakeLlama()
    let notify: ((message: string) => void) | undefined
    vi.mocked(llama.ensureServing).mockImplementation(
      async (
        spec: { id: string },
        _fit,
        _hardware,
        options?: { onNotice?: (m: string) => void },
      ) => {
        notify = options?.onNotice
        return {
          model: spec.id,
          inferenceURL: "http://127.0.0.1:1/v1/chat/completions",
          contextLength: 65_536,
        }
      },
    )
    const host = new ModelHost({ llama })
    const notices: string[] = []
    host.onNotice = (message) => notices.push(message)
    await host.prepare(
      {
        provider: "local",
        id: "openai/gpt-oss-20b",
        displayName: "gpt-oss",
        contextLength: 65_536,
        supportsImageInput: false,
      },
      { signal: new AbortController().signal },
    )
    host.cancelPrepare()
    notify?.("late notice")
    expect(notices).toEqual([])
  })

  it("persists then commits a prepared selection", async () => {
    const host = new ModelHost({ llama: fakeLlama() })
    const order: string[] = []
    await host.persistSelection(hosted, {
      signal: new AbortController().signal,
      fireworksApiKey: "fw_test",
      persist: async () => {
        expect(host.selectedId).toBeUndefined()
        order.push("persist")
      },
    })
    expect(order).toEqual(["persist"])
    expect(host.selectedId).toBe(hosted.id)
    expect(host.client?.model).toBe(hosted.id)
  })

  it("rolls back when persistence fails", async () => {
    const host = new ModelHost({ llama: fakeLlama() })
    await expect(
      host.persistSelection(hosted, {
        signal: new AbortController().signal,
        fireworksApiKey: "fw_test",
        persist: async () => {
          throw new Error("config is read-only")
        },
      }),
    ).rejects.toThrow("config is read-only")
    expect(host.selectedId).toBeUndefined()
    expect(host.client).toBeUndefined()
  })

  it("keeps a failed selection on its picker row until the next attempt", async () => {
    const llama = fakeLlama()
    vi.mocked(llama.ensureServing).mockImplementation(async (_spec, _fit, _hardware, options) => {
      options?.onProgress?.({ phase: "download", percent: 42 })
      throw new Error("no space left")
    })
    const host = new ModelHost({ llama })
    const seen: unknown[] = []
    host.subscribe(() => seen.push(host.load))
    const model = {
      provider: "local" as const,
      id: "openai/gpt-oss-20b",
      displayName: "gpt-oss",
      contextLength: 65_536,
      supportsImageInput: false,
    }
    const persist = vi.fn()
    await expect(
      host.persistSelection(model, { signal: new AbortController().signal, persist }),
    ).rejects.toThrow("no space left")
    expect(seen).toContainEqual({
      modelId: model.id,
      status: { label: "Downloading 42%", kind: "progress" },
    })
    expect(host.load).toEqual({
      modelId: model.id,
      status: { label: "Failed: no space left", kind: "error" },
    })
    expect(host.state).toBe("failed")
    expect(host.error).toBe("no space left")
    expect(persist).not.toHaveBeenCalled()

    // The next attempt clears the row first and reports on the caller's key.
    const controller = new AbortController()
    controller.abort()
    await expect(
      host.persistSelection(model, { signal: controller.signal, persist, loadKey: "row" }),
    ).rejects.toThrow()
    expect(host.load).toBeUndefined()
  })

  it("marks a selection open from enqueue until it settles", async () => {
    const host = new ModelHost({ llama: fakeLlama() })
    const states: boolean[] = []
    host.subscribe(() => states.push(host.selecting))
    let finish!: () => void
    const pending = host.enqueueSelection(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    expect(host.selecting).toBe(true)
    await vi.waitFor(() => expect(finish).toBeDefined())
    finish()
    await pending
    expect(host.selecting).toBe(false)
    expect(states).toEqual([true, false])
  })

  it("serializes selections and aborts the previous request", async () => {
    const host = new ModelHost({ llama: fakeLlama() })
    let firstSignal: AbortSignal | undefined
    const first = host.enqueueSelection(async (signal) => {
      firstSignal = signal
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true })
      })
      return "first"
    })
    await vi.waitFor(() => expect(firstSignal).toBeDefined())
    const second = await host.enqueueSelection(async () => "second")
    expect(firstSignal?.aborted).toBe(true)
    expect(await first).toBe("first")
    expect(second).toBe("second")
  })
})

function fakeLlama() {
  return {
    alive: true,
    stop: vi.fn(async () => undefined),
    ensureServing: vi.fn(),
  } as unknown as LlamaCppRuntime
}
