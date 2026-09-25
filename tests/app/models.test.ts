import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  GatedInferenceClient,
  InferenceGate,
  isAbortError,
  ModelHost,
} from "../../src/app/models.js"
import { autoCompactThreshold } from "../../src/core/compaction.js"
import { compactionContextLength } from "../../src/inference/context-policy.js"
import type { LlamaCppRuntime } from "../../src/inference/llama-runtime.js"
import type {
  ChatStreamEvent,
  FireworksModel,
  OmlxCatalogModel,
  StreamChatOptions,
} from "../../src/inference/types.js"
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
    const selection = await host.persistSelection(model, {
      signal: new AbortController().signal,
      persist,
    })
    expect(host.autoCompactAtTokens(selection.model)).toBe(
      autoCompactThreshold(contextLength ?? 65536),
    )
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
    const saved = host.savedSelection({
      model: "chat",
      modelProvider: "pair",
      pairEngine: engine,
      modelContextLength: 262144,
      pairEndpoints: engine === "ollama" ? { ollama: endpoint } : { lmStudio: endpoint },
    })
    expect(host.autoCompactAtTokens(saved?.model)).toBe(autoCompactThreshold(65_536))
    expect(saved?.client?.model).toBe("chat")
    const connected = await host.connect({
      provider: "pair",
      modelId: "chat",
      pairEngine: engine,
      pairEndpoint: endpoint,
      contextLength: 262144,
    })
    expect(compactionContextLength(connected.model)).toBe(65_536)
    expect(host.autoCompactAtTokens(connected.model)).toBe(autoCompactThreshold(65_536))
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

    const selection = host.savedSelection(settings)

    expect(selection?.model.id).toBe(settings.model)
    expect(selection?.model.provider).toBe("fireworks")
    expect(selection?.supportsImageInput).toBe(true)
    expect(selection?.client?.model).toBe(settings.model)
    expect(host.autoCompactAtTokens(selection?.model)).toBe(
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
    expect((connected.model as FireworksModel).contextLength).toBe(131_072)
    expect(host.autoCompactAtTokens(connected.model)).toBe(autoCompactThreshold(131_072))
    expect(mocks.listToolCapableModels).toHaveBeenCalledOnce()

    const again = await host.connect({
      provider: "fireworks",
      modelId: hosted.id,
      fireworksApiKey: "fw_test",
      contextLength: 65_536,
    })
    expect(host.autoCompactAtTokens(again.model)).toBe(autoCompactThreshold(65_536))
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
    expect((connected.model as FireworksModel).contextLength).toBeUndefined()
    expect(host.autoCompactAtTokens(connected.model)).toBe(autoCompactThreshold(131_072))
  })

  it("reserves more output for a high thinking effort at 64K and nothing extra at 128K", () => {
    const host = new ModelHost({ llama: fakeLlama() })
    const saved = (settings: LocalSettings) => host.savedSelection(settings)?.model
    const local = saved({
      model: "Qwen/Qwen3.8-27B",
      modelProvider: "local",
      modelContextLength: 65_536,
    })
    expect(host.autoCompactAtTokens(local)).toBe(49_152)
    host.localThinking = { "Qwen/Qwen3.8-27B": "low" }
    expect(host.autoCompactAtTokens(local)).toBe(52_428)
    host.localThinking = { "Qwen/Qwen3.8-27B": "xhigh" }
    expect(host.autoCompactAtTokens(local)).toBe(49_152)

    expect(
      host.autoCompactAtTokens(
        saved({ model: "Qwen/Qwen3.8-27B", modelProvider: "local", modelContextLength: 131_072 }),
      ),
    ).toBe(104_857)

    expect(
      host.autoCompactAtTokens(
        saved({
          fireworksApiKey: "fw_test",
          model: "accounts/fireworks/models/deepseek-v4",
          modelProvider: "fireworks",
          modelContextLength: 65_536,
        }),
      ),
    ).toBe(49_152)
    expect(
      host.autoCompactAtTokens(
        saved({
          fireworksApiKey: "fw_test",
          model: "accounts/fireworks/models/llama-v3p1-70b-instruct",
          modelProvider: "fireworks",
          modelContextLength: 65_536,
        }),
      ),
    ).toBe(52_428)
  })

  it("records a local selection without creating a client until serving starts", () => {
    const host = new ModelHost()
    const selection = host.savedSelection({
      model: "Qwen/Qwen3.8-27B",
      modelProvider: "local",
      modelContextLength: 65_536,
    })

    expect(selection?.model.provider).toBe("local")
    expect(selection?.client).toBeUndefined()
    // The model's default thinking effort reserves 16K of the 64K window for output.
    expect(host.autoCompactAtTokens(selection?.model)).toBe(autoCompactThreshold(65_536, 16_384))
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
          slots: 1,
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
    expect(host.activeLocal?.spec.id).toBe(model.id)
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
          slots: 1,
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
    const selection = await host.persistSelection(hosted, {
      signal: new AbortController().signal,
      fireworksApiKey: "fw_test",
      persist: async () => {
        order.push("persist")
      },
    })
    expect(order).toEqual(["persist"])
    expect(selection.model.id).toBe(hosted.id)
    expect(selection.client?.model).toBe(hosted.id)
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
    expect(host.activeLocal).toBeUndefined()
    expect(host.state).toBe("failed")
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

  it("hands each owner one gated view of its selection until the raw client changes", () => {
    const host = new ModelHost({ llama: fakeLlama() })
    expect(host.clientFor(1, undefined)).toBeUndefined()
    const raw = { model: "fake", streamChat: vi.fn(), complete: vi.fn() }
    const selection = { model: hosted, supportsImageInput: false, client: raw }
    const gated = host.clientFor(1, selection)
    expect(gated).toBeInstanceOf(GatedInferenceClient)
    expect(gated).toBe(host.clientFor(1, selection))
    expect(gated?.inner).toBe(raw)
    expect(gated?.model).toBe("fake")
    expect(host.clientFor(2, selection)).not.toBe(gated)
    const next = { ...selection, client: { ...raw } }
    expect(host.clientFor(1, next)).not.toBe(gated)
    expect(host.clientFor(1, next)?.inner).toBe(next.client)
    expect(host.clientFor(1, next)).toBe(host.clientFor(1, next))
    // Hosted requests never wait behind the managed server's slots.
    expect(gated?.gate).not.toBe(host.gate)
  })

  it("sizes the gate to the local server's slots and leaves hosted providers unbounded", async () => {
    const llama = fakeLlama()
    vi.mocked(llama.ensureServing).mockResolvedValue({
      model: "openai/gpt-oss-20b",
      inferenceURL: "http://127.0.0.1:1/v1/chat/completions",
      contextLength: 65_536,
      slots: 2,
    })
    const host = new ModelHost({ llama })
    expect(host.gate.capacity).toBe(Number.POSITIVE_INFINITY)
    await host.connect({ provider: "local", modelId: "openai/gpt-oss-20b" })
    expect(host.gate.capacity).toBe(2)
    expect(host.activeLocal?.slots).toBe(2)
    await host.persistSelection(hosted, {
      signal: new AbortController().signal,
      fireworksApiKey: "fw_test",
      persist: async () => undefined,
    })
    expect(host.gate.capacity).toBe(Number.POSITIVE_INFINITY)
  })
})

describe("InferenceGate", () => {
  it("grants leases first come first served across owners on one slot", async () => {
    const gate = new InferenceGate(1)
    const changes: number[] = []
    gate.subscribe(() => changes.push(gate.active * 10 + gate.waiting))
    const a = track(gate.acquire(1))
    const b = track(gate.acquire(2))
    const c = track(gate.acquire(1))
    await tick()
    expect([a.status, b.status, c.status]).toEqual(["granted", "pending", "pending"])
    expect([gate.isWaiting(1), gate.isWaiting(2), gate.isWaiting(3)]).toEqual([true, true, false])
    a.value?.release()
    await tick()
    expect([b.status, c.status]).toEqual(["granted", "pending"])
    expect(gate.active).toBe(1)
    expect(gate.waiting).toBe(1)
    b.value?.release()
    await tick()
    expect(c.status).toBe("granted")
    c.value?.release()
    expect([gate.active, gate.waiting]).toEqual([0, 0])
    expect(changes).toEqual([10, 11, 12, 11, 10, 0])
  })

  it("drops a waiter whose signal aborts and grants the next in line", async () => {
    const gate = new InferenceGate(1)
    const held = await gate.acquire(1)
    const controller = new AbortController()
    const b = track(gate.acquire(2, controller.signal))
    const c = track(gate.acquire(3))
    controller.abort()
    await tick()
    expect(b.status).toBe("rejected")
    expect(isAbortError(b.error)).toBe(true)
    expect(gate.waiting).toBe(1)
    held.release()
    await tick()
    expect(c.status).toBe("granted")
    expect([gate.active, gate.waiting]).toEqual([1, 0])
    await expect(gate.acquire(4, controller.signal)).rejects.toSatisfy(isAbortError)
    expect(gate.waiting).toBe(0)
  })

  it("grants waiters in order when capacity rises and only future grants when it falls", async () => {
    const gate = new InferenceGate(1)
    const a = await gate.acquire(1)
    const b = track(gate.acquire(2))
    const c = track(gate.acquire(3))
    const d = track(gate.acquire(4))
    gate.setCapacity(3)
    await tick()
    expect([b.status, c.status, d.status]).toEqual(["granted", "granted", "pending"])
    expect(gate.active).toBe(3)
    gate.setCapacity(1)
    expect(gate.active).toBe(3)
    a.release()
    await tick()
    expect(d.status).toBe("pending")
    b.value?.release()
    c.value?.release()
    await tick()
    expect(d.status).toBe("granted")
    expect([gate.active, gate.waiting]).toEqual([1, 0])
  })
})

describe("GatedInferenceClient", () => {
  it("holds a slot for exactly the stream and frees it when the stream aborts", async () => {
    const gate = new InferenceGate(1)
    const inner = fakeInner()
    const first = new GatedInferenceClient(inner, gate, 1)
    const second = new GatedInferenceClient(inner, gate, 2)
    const controller = new AbortController()
    const streamA = first.streamChat({ messages: [], signal: controller.signal })
    expect((await streamA.next()).value).toEqual({ type: "text_delta", text: "hi" })
    const streamB = second.streamChat({ messages: [] })
    const nextB = track(streamB.next())
    await tick()
    expect(nextB.status).toBe("pending")
    expect([gate.active, gate.isWaiting(2)]).toEqual([1, true])
    controller.abort()
    await expect(streamA.next()).rejects.toSatisfy(isAbortError)
    await tick()
    expect(nextB.status).toBe("granted")
    expect([gate.active, gate.isWaiting(2)]).toEqual([1, false])
    await streamB.return(undefined)
    expect(gate.active).toBe(0)
  })

  it("rejects a stream cancelled while waiting without ever taking the slot", async () => {
    const gate = new InferenceGate(1)
    const client = new GatedInferenceClient(fakeInner(), gate, 1)
    const held = await gate.acquire(9)
    const controller = new AbortController()
    const next = track(client.streamChat({ messages: [], signal: controller.signal }).next())
    await tick()
    expect(gate.waiting).toBe(1)
    controller.abort()
    await tick()
    expect(next.status).toBe("rejected")
    expect(isAbortError(next.error)).toBe(true)
    expect([gate.active, gate.waiting]).toEqual([1, 0])
    held.release()
  })

  it("routes complete() through the gate and counts tokens without a slot", async () => {
    const gate = new InferenceGate(1)
    const inner = fakeInner()
    const client = new GatedInferenceClient(inner, gate, 7)
    const held = await gate.acquire(1)
    const completion = track(client.complete([{ role: "user", content: "hi" }]))
    await tick()
    expect(completion.status).toBe("pending")
    expect([gate.active, gate.isWaiting(7)]).toEqual([1, true])
    expect(await client.countTokens?.({ messages: [] })).toBe(42)
    expect(inner.complete).not.toHaveBeenCalled()
    held.release()
    await tick()
    expect(inner.complete).toHaveBeenCalledOnce()
    expect(completion).toMatchObject({ status: "granted", value: "hi" })
    expect(gate.active).toBe(0)
    expect(
      new GatedInferenceClient({ ...inner, countTokens: undefined }, gate, 1).countTokens,
    ).toBeUndefined()
  })
})

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** Settlement of a promise, readable synchronously after a tick. */
function track<T>(promise: Promise<T>) {
  const state: { status: "pending" | "granted" | "rejected"; value?: T; error?: unknown } = {
    status: "pending",
  }
  promise.then(
    (value) => Object.assign(state, { status: "granted", value }),
    (error) => Object.assign(state, { status: "rejected", error }),
  )
  return state
}

/** Streams one delta, then holds the stream open until the request aborts or is returned. */
function fakeInner() {
  return {
    model: "fake",
    countTokens: async () => 42,
    async *streamChat(options: StreamChatOptions): AsyncGenerator<ChatStreamEvent> {
      yield { type: "text_delta", text: "hi" }
      await new Promise<void>((_resolve, reject) => {
        const abort = () => reject(new DOMException("aborted", "AbortError"))
        if (options.signal?.aborted) abort()
        else options.signal?.addEventListener("abort", abort, { once: true })
      })
      yield { type: "finish", reason: "stop" }
    },
    complete: vi.fn(async () => "hi"),
  }
}

function fakeLlama() {
  return {
    alive: true,
    stop: vi.fn(async () => undefined),
    ensureServing: vi.fn(),
  } as unknown as LlamaCppRuntime
}
