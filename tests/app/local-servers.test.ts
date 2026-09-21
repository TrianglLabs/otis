import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Application } from "../../src/app/application.js"
import { prepareLocalServers } from "../../src/app/local-servers.js"
import { autoCompactThreshold } from "../../src/core/compaction.js"
import { providerTools } from "../../src/core/subagent.js"
import { DesktopRuntime } from "../../src/desktop/main/runtime.js"
import type { OmlxCatalogModel } from "../../src/inference/types.js"
import { localConfigDirectory } from "../../src/local/paths.js"
import {
  clearSelectedModel,
  loadLocalSettings,
  saveSelectedModel,
  saveSelectedTheme,
} from "../../src/local/settings.js"
import { useOtisHome } from "./support/otis-home.js"

const isolate = useOtisHome()
afterEach(() => vi.unstubAllGlobals())
const model: OmlxCatalogModel = {
  provider: "omlx",
  id: "chat",
  displayName: "Chat",
  baseURL: "http://127.0.0.1:8000",
  contextLength: 131072,
  supportsImageInput: true,
}
const discoverPair = vi.fn(async () => ({ errors: [] }))
const discoverOmlx = vi.fn(async () => [model])

describe("local server coordination", () => {
  it("saves oMLX privately, selects without inference, and exposes no key to the renderer", async () => {
    const cwd = await isolate("otis-omlx-")
    const app = await Application.create({ cwd, env: {} })
    const runtime = DesktopRuntime.forApplication(app, {
      cwd,
      version: "test",
      platform: "darwin",
      send: () => {},
      discoverPair,
      discoverOmlx,
    })
    const stop = vi.spyOn(app.models.llama, "stop").mockResolvedValue()
    const network = vi.fn(() => {
      throw new Error("unexpected network call")
    })
    vi.stubGlobal("fetch", network)
    expect(await runtime.connectLocalServers({ omlx: `${model.baseURL}/v1`, omlxApiKey: "private-omlx-key" })).toEqual({
      ok: true,
    })
    expect(
      (await runtime.listModels()).filter((item) => item.kind === "model" && item.provider === "omlx"),
    ).toMatchObject([{ selectionKey: "omlx:chat", supportsImageInput: true }])
    expect(await runtime.selectModel("omlx:chat")).toEqual({ ok: true })
    expect(stop).toHaveBeenCalled()
    expect(network).not.toHaveBeenCalled()
    expect(app.models.autoCompactAtTokens).toBe(autoCompactThreshold(131072))
    expect(providerTools("omlx").some((tool) => tool.name === "agent")).toBe(true)
    const snapshot = await runtime.snapshot()
    expect(snapshot.omlx).toEqual({ baseURL: model.baseURL, hasApiKey: true })
    expect(JSON.stringify(snapshot)).not.toContain("private-omlx-key")
    await saveSelectedTheme("nord")
    expect(await loadLocalSettings({ env: {} })).toMatchObject({
      modelProvider: "omlx",
      omlx: { baseURL: model.baseURL, apiKey: "private-omlx-key" },
    })
    if (process.platform !== "win32")
      expect((await stat(join(localConfigDirectory(), "config.json"))).mode & 0o777).toBe(0o600)
    await clearSelectedModel()
    expect(await loadLocalSettings({ env: {} })).toMatchObject({ omlx: { apiKey: "private-omlx-key" } })
    await app.shutdown()
  })

  it("rebuilds the active client on reconnect, preserves a blank key on the same endpoint, and invalidates removed servers", async () => {
    const cwd = await isolate("otis-omlx-reconnect-")
    const app = await Application.create({ cwd, env: {} })
    await app.connectLocalServers({ omlx: model.baseURL, omlxApiKey: "key-one" }, { discoverPair, discoverOmlx })
    app.models.activate(model, app.models.omlxClient(model.id, model.baseURL))
    const previous = app.models.client
    await app.connectLocalServers({ omlx: model.baseURL, omlxApiKey: "" }, { discoverPair, discoverOmlx })
    expect(app.models.omlx?.apiKey).toBe("key-one")
    expect(app.models.client).not.toBe(previous)
    const beforeFailure = await readFile(join(localConfigDirectory(), "config.json"), "utf8")
    await expect(
      app.connectLocalServers(
        { omlx: model.baseURL, omlxApiKey: "bad-key" },
        {
          discoverPair,
          discoverOmlx: async () => {
            throw new Error("HTTP 401")
          },
        },
      ),
    ).rejects.toThrow("401")
    expect(await readFile(join(localConfigDirectory(), "config.json"), "utf8")).toBe(beforeFailure)
    const changed = { ...model, baseURL: "http://127.0.0.1:8001", contextLength: 65536 }
    await app.connectLocalServers({ omlx: changed.baseURL }, { discoverPair, discoverOmlx: async () => [changed] })
    expect(app.models.omlx).toEqual({ baseURL: changed.baseURL })
    expect(app.models.autoCompactAtTokens).toBe(autoCompactThreshold(65536))
    await app.connectLocalServers(
      { ollama: "http://127.0.0.1:11434" },
      {
        discoverPair: async () => ({
          ollama: [
            {
              provider: "pair",
              engine: "ollama",
              id: "other",
              displayName: "Other",
              baseURL: "http://127.0.0.1:11434",
              supportsImageInput: false,
            },
          ],
          errors: [],
        }),
      },
    )
    expect(app.models.omlx).toBeUndefined()
    expect(app.models.client).toBeUndefined()
    expect(app.hasConfiguredSelection()).toBe(false)
    await app.shutdown()
  })

  it.each([
    65536, 8192,
  ])("validates the refreshed serving limit %i on restart without loading models or invoking inference", async (contextLength) => {
    const cwd = await isolate("otis-omlx-restore-")
    const app = await Application.create({ cwd, env: {} })
    await app.connectLocalServers({ omlx: model.baseURL }, { discoverPair, discoverOmlx })
    await saveSelectedModel(model)
    await app.shutdown()
    const fetch = vi.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith("/status")
        ? Response.json({ models: [{ id: "chat", model_type: "llm" }] })
        : Response.json({ data: [{ id: "chat", max_model_len: contextLength }] }),
    )
    vi.stubGlobal("fetch", fetch)
    const restored = await Application.create({ cwd, env: {} })
    if (contextLength < 65536) {
      await expect(restored.startSavedSelection()).rejects.toThrow("at least 65,536 tokens (64K)")
      expect(restored.models.client).toBeUndefined()
    } else {
      expect(await restored.startSavedSelection()).toBe("ready")
      expect(restored.models.autoCompactAtTokens).toBe(autoCompactThreshold(contextLength))
      expect(restored.models.supportsImageInput).toBe(false)
    }
    expect(fetch).toHaveBeenCalledTimes(2)
    await restored.shutdown()
  })

  it.each([
    "same",
    "different",
  ])("rejects an undersized reconnect to the %s server and preserves valid selection state", async (destination) => {
    const cwd = await isolate("otis-omlx-minimum-")
    const app = await Application.create({ cwd, env: {} })
    await app.connectLocalServers({ omlx: model.baseURL }, { discoverPair, discoverOmlx })
    app.models.activate(model, app.models.omlxClient(model.id, model.baseURL))
    const previous = app.models.client
    const before = await readFile(join(localConfigDirectory(), "config.json"), "utf8")
    const undersized = {
      ...model,
      baseURL: destination === "same" ? model.baseURL : "http://127.0.0.1:8001",
      contextLength: 8192,
    }
    const runtime = DesktopRuntime.forApplication(app, {
      cwd,
      version: "test",
      platform: "darwin",
      send: () => {},
      discoverPair,
      discoverOmlx: async () => [undersized],
    })
    expect(await runtime.connectLocalServers({ omlx: undersized.baseURL })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("at least 65,536 tokens (64K)"),
    })
    expect(await readFile(join(localConfigDirectory(), "config.json"), "utf8")).toBe(before)
    expect(app.models.client).toBe(destination === "same" ? undefined : previous)
    if (destination === "same") {
      const snapshot = await runtime.snapshot()
      expect(snapshot.modelState).toBe("failed")
      expect(snapshot.modelError).toContain("64K")
    }
    await runtime.shutdown()
  })

  it("propagates cancellation and rejects empty or malformed setup", async () => {
    await expect(prepareLocalServers({}, undefined)).rejects.toThrow("Enter at least one")
    await expect(prepareLocalServers({ omlx: "http://example.com" }, undefined)).rejects.toThrow("127.0.0.1")
    await expect(
      prepareLocalServers({ omlx: model.baseURL }, undefined, { discoverPair, discoverOmlx: async () => [] }),
    ).rejects.toThrow("no available models")
    const controller = new AbortController()
    controller.abort()
    await expect(
      prepareLocalServers({ omlx: model.baseURL }, undefined, {
        signal: controller.signal,
        discoverPair,
        discoverOmlx,
      }),
    ).rejects.toMatchObject({ name: "AbortError" })
  })
})
