import { describe, expect, it, vi } from "vitest"
import { ModelHost } from "../../src/app/models.js"
import { autoCompactThreshold } from "../../src/core/compaction.js"
import { compactionContextLength } from "../../src/inference/context-policy.js"
import type { LlamaCppRuntime } from "../../src/inference/llama-runtime.js"
import type { FireworksModel } from "../../src/inference/types.js"
import type { LocalSettings } from "../../src/local/settings.js"

const hosted: FireworksModel = {
  provider: "fireworks",
  id: "accounts/fireworks/models/example",
  displayName: "example",
  supportsImageInput: false,
}

describe("ModelHost", () => {
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
      autoCompactThreshold(compactionContextLength({ provider: "fireworks", contextLength: 128_000 })),
    )
    expect(host.activeLocal).toBeUndefined()
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
  return { stop: vi.fn(async () => undefined), ensureServing: vi.fn() } as unknown as LlamaCppRuntime
}
