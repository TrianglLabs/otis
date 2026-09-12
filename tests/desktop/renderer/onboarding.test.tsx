// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DesktopApi, DesktopEvent, DesktopSnapshot } from "../../../src/desktop/contracts.js"
import { App } from "../../../src/desktop/renderer/App.js"
import { DesktopProvider } from "../../../src/desktop/renderer/runtime.js"
import { DesktopViewStore } from "../../../src/desktop/renderer/state.js"
import type { ModelPickerItem } from "../../../src/inference/picker-catalog.js"

/** First-run onboarding: it owns the window until a model is configured, and never offers PAIR. */

const SNAPSHOT: DesktopSnapshot = {
  busy: false,
  phase: "idle",
  model: null,
  modelState: "unconfigured",
  modelError: undefined,
  session: { id: "session-1", title: "New session" },
  needsWorkspace: false,
  sessions: [],
  contextTokens: undefined,
  contextLimit: 32_768,
  diffs: { added: 0, removed: 0 },
  permission: null,
  stats: undefined,
  modelLoad: null,
  subagents: [],
  agentsPanelVisible: true,
  theme: "default",
  thinkingVisible: false,
  permissionMode: "auto",
  fastServing: { available: false, enabled: false },
  hostedConfigured: false,
  pairConfigured: false,
  pairEndpoints: {},
  debug: false,
  update: { status: "idle" },
  platform: "darwin",
  version: "0.0.0-test",
  workspace: { label: "otis", path: "/tmp/otis" },
  entries: [],
  revision: 1,
}

const FIREWORKS_ITEM: ModelPickerItem = {
  kind: "model",
  provider: "fireworks",
  id: "accounts/fireworks/models/kimi-k2p6",
  displayName: "Kimi K2.6",
  supportsImageInput: false,
  available: true,
  active: false,
}

const LOCAL_ITEM: ModelPickerItem = {
  kind: "model",
  provider: "local",
  id: "Qwen/Qwen3.5-9B",
  displayName: "Qwen 3.5 9B",
  contextLength: 32_768,
  supportsImageInput: false,
  available: true,
  availabilityLabel: "Est. 32K · Q4_K_M · 6 GB",
  recommended: true,
  downloaded: false,
  active: false,
}

const OTHER_LOCAL_ITEM: ModelPickerItem = {
  kind: "model",
  provider: "local",
  id: "Qwen/Qwen3.5-27B",
  displayName: "Qwen 3.5 27B",
  contextLength: 32_768,
  supportsImageInput: false,
  available: true,
  recommended: false,
  availabilityLabel: "Est. 32K · Q4_K_M · 16 GB",
  downloaded: false,
  active: false,
}

const PAIR_ITEM: ModelPickerItem = {
  kind: "model",
  provider: "pair",
  id: "qwen3:32b",
  displayName: "PAIR cluster model",
  baseURL: "http://127.0.0.1:11434",
  engine: "ollama",
  supportsImageInput: false,
  available: true,
  active: false,
  selectionKey: "ollama:qwen3:32b",
}

function fakeApi(overrides: Partial<DesktopApi> = {}): DesktopApi {
  return {
    getSnapshot: vi.fn(async () => SNAPSHOT),
    sendPrompt: vi.fn(async () => ({ accepted: true as const, delivery: "started" as const })),
    stop: vi.fn(async () => {}),
    respondToPermission: vi.fn(async () => {}),
    selectSession: vi.fn(async () => ({ ok: true as const })),
    searchSessions: vi.fn(async () => []),
    startNewSession: vi.fn(async () => ({ ok: true as const })),
    deleteSession: vi.fn(async () => ({ ok: true as const })),
    openSessionAt: vi.fn(async () => ({ ok: true as const })),
    openWorkspace: vi.fn(async () => ({ ok: true as const })),
    locateWorkspace: vi.fn(async () => ({ ok: true as const })),
    pickWorkspaceFolder: vi.fn(async () => undefined),
    registerWorkspace: vi.fn(async () => ({ ok: true as const })),
    refreshSessions: vi.fn(async () => {}),
    listModels: vi.fn(async () => [FIREWORKS_ITEM, LOCAL_ITEM, OTHER_LOCAL_ITEM, PAIR_ITEM]),
    selectModel: vi.fn(async () => ({ ok: true as const })),
    cancelModelSelection: vi.fn(async () => {}),
    getSubagentTrace: vi.fn(async () => []),
    setAgentsPanelVisible: vi.fn(async () => {}),
    setTheme: vi.fn(async () => {}),
    setThinkingVisible: vi.fn(async () => {}),
    setPermissionMode: vi.fn(async () => {}),
    setFastServing: vi.fn(async () => ({ ok: true as const })),
    openFireworksKeyPage: vi.fn(async () => {}),
    setFireworksApiKey: vi.fn(async () => ({ ok: true as const })),
    connectPairEndpoints: vi.fn(async () => ({ ok: true as const })),
    deleteLocalModel: vi.fn(async () => ({ ok: true as const })),
    setDebugMode: vi.fn(async () => {}),
    installUpdate: vi.fn(async () => {}),
    checkForUpdates: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
    ...overrides,
  }
}

async function renderApp(api: DesktopApi) {
  const store = new DesktopViewStore(api)
  await store.start()
  render(
    <DesktopProvider value={{ api, store }}>
      <App />
    </DesktopProvider>,
  )
}

afterEach(() => cleanup())

function rowButton(name: HTMLElement): HTMLButtonElement {
  const row = name.closest("button")
  if (!row) throw new Error("row button not found")
  return row
}

describe("OnboardingPage", () => {
  it("owns the window until a model is configured — no composer, no transcript", async () => {
    await renderApp(fakeApi())
    expect(await screen.findByText(/Your personal AI agent, powered by open models/)).toBeTruthy()
    expect(screen.queryByLabelText("Prompt")).toBeNull()
    // The workspace header stays out of onboarding (no Search / context meter)…
    expect(screen.queryByRole("button", { name: /search/i })).toBeNull()
    // …but Settings is reachable — PAIR setup lives there and may be the user's first provider.
    fireEvent.click(screen.getByRole("button", { name: "Settings" }))
    expect(await screen.findByText("Theme")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /close settings/i }))
    expect(await screen.findByText(/Your personal AI agent/)).toBeTruthy()
  })

  it("cloud path saves the Fireworks key, then lists hosted models without PAIR entries", async () => {
    const api = fakeApi({
      getSnapshot: vi.fn(async () => ({ ...SNAPSHOT, hostedConfigured: true })),
    })
    await renderApp(api)
    fireEvent.click(await screen.findByRole("button", { name: /Hosted/ }))

    // Key already configured → straight to the hosted model list; PAIR inventory never appears.
    const row = rowButton(await screen.findByText("Kimi K2.6"))
    expect(screen.queryByText("PAIR cluster model")).toBeNull()
    expect(screen.queryByText("Qwen 3.5 9B")).toBeNull()
    fireEvent.click(row)
    expect(api.selectModel).toHaveBeenCalledWith("accounts/fireworks/models/kimi-k2p6")
  })

  it("cloud path without a key shows the key form and saves it", async () => {
    const api = fakeApi()
    await renderApp(api)
    fireEvent.click(await screen.findByRole("button", { name: /Hosted/ }))
    fireEvent.change(screen.getByLabelText("Fireworks API key"), { target: { value: "fw_test_key" } })
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }))
    expect(api.setFireworksApiKey).toHaveBeenCalledWith("fw_test_key")
    // No model rows until the key is in place.
    expect(screen.queryByText("Kimi K2.6")).toBeNull()
  })

  it("reloads the catalog when saving the key flips hostedConfigured", async () => {
    let listener: ((event: DesktopEvent) => void) | undefined
    const api = fakeApi({
      subscribe: vi.fn((fn: (event: DesktopEvent) => void) => {
        listener = fn
        return () => {}
      }),
    })
    await renderApp(api)
    fireEvent.click(await screen.findByRole("button", { name: /Hosted/ }))
    expect(api.listModels).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText("Fireworks API key"), { target: { value: "fw_test_key" } })
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }))
    // The runtime accepts the key and echoes hostedConfigured through a status event.
    const { entries: _e, revision: _r, ...status } = SNAPSHOT
    await act(async () => listener?.({ type: "status", revision: 2, status: { ...status, hostedConfigured: true } }))
    expect(api.listModels).toHaveBeenCalled()
    expect(await screen.findByText("Kimi K2.6")).toBeTruthy()
  })

  it("local path shows only the top recommended model with a download-and-continue action", async () => {
    const api = fakeApi()
    await renderApp(api)
    fireEvent.click(await screen.findByRole("button", { name: /On this Mac/ }))

    expect(await screen.findByText("Qwen 3.5 9B")).toBeTruthy()
    // No list to dig through: other local models, hosted models, and PAIR inventory stay hidden.
    expect(screen.queryByText("Qwen 3.5 27B")).toBeNull()
    expect(screen.queryByText("Kimi K2.6")).toBeNull()
    expect(screen.queryByText("PAIR cluster model")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /Download and continue/ }))
    expect(api.selectModel).toHaveBeenCalledWith("Qwen/Qwen3.5-9B")
  })

  it("PAIR as first provider: connect in Settings, pick a model there, land in the workspace", async () => {
    let listener: ((event: DesktopEvent) => void) | undefined
    const api = fakeApi({
      subscribe: vi.fn((fn: (event: DesktopEvent) => void) => {
        listener = fn
        return () => {}
      }),
    })
    await renderApp(api)
    const { entries: _e, revision: _r, ...status } = SNAPSHOT

    // Settings is reachable from onboarding; PAIR lives there exclusively.
    fireEvent.click(screen.getByRole("button", { name: "Settings" }))
    fireEvent.click(await screen.findByRole("button", { name: /NVIDIA PAIR/ }))
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    expect(api.connectPairEndpoints).toHaveBeenCalled()

    // Endpoints answer → models list inside Settings, no onboarding card involved.
    await act(async () => listener?.({ type: "status", revision: 2, status: { ...status, pairConfigured: true } }))
    fireEvent.click(await screen.findByText("PAIR cluster model"))
    expect(api.selectModel).toHaveBeenCalledWith("ollama:qwen3:32b")

    // Selection sets the model → closing Settings lands in the workspace, not onboarding.
    await act(async () =>
      listener?.({
        type: "status",
        revision: 3,
        status: {
          ...status,
          pairConfigured: true,
          model: {
            id: "qwen3:32b",
            provider: "pair",
            displayName: "PAIR cluster model",
            supportsImageInput: false,
          },
          modelState: "ready" as const,
        },
      }),
    )
    fireEvent.click(screen.getByRole("button", { name: /close settings/i }))
    expect(await screen.findByLabelText("Prompt")).toBeTruthy()
    expect(screen.queryByText(/Your personal AI agent/)).toBeNull()
  })

  it("reconnecting PAIR refreshes the model list — no stale rows", async () => {
    const NEW_PAIR_ITEM: ModelPickerItem = {
      kind: "model",
      provider: "pair",
      id: "llama3.3:70b",
      displayName: "New cluster model",
      baseURL: "http://127.0.0.1:11435",
      engine: "ollama",
      supportsImageInput: false,
      available: true,
      active: false,
      selectionKey: "ollama:llama3.3:70b",
    }
    let catalog: ModelPickerItem[] = [PAIR_ITEM]
    const api = fakeApi({
      getSnapshot: vi.fn(async () => ({ ...SNAPSHOT, pairConfigured: true })),
      listModels: vi.fn(async () => catalog),
    })
    await renderApp(api)

    fireEvent.click(screen.getByRole("button", { name: "Settings" }))
    fireEvent.click(await screen.findByRole("button", { name: /NVIDIA PAIR/ }))
    expect(await screen.findByText("PAIR cluster model")).toBeTruthy()

    // The endpoint changed behind our back; reconnecting must drop the old catalog.
    catalog = [NEW_PAIR_ITEM]
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    expect(await screen.findByText("New cluster model")).toBeTruthy()
    expect(screen.queryByText("PAIR cluster model")).toBeNull()
  })

  it("moves the PAIR checkmark to the selected model without reopening Settings", async () => {
    let catalog: ModelPickerItem[] = [{ ...PAIR_ITEM, active: false }]
    const api = fakeApi({
      getSnapshot: vi.fn(async () => ({ ...SNAPSHOT, pairConfigured: true })),
      listModels: vi.fn(async () => catalog),
    })
    await renderApp(api)
    fireEvent.click(screen.getByRole("button", { name: "Settings" }))
    fireEvent.click(await screen.findByRole("button", { name: /NVIDIA PAIR/ }))

    const row = rowButton(await screen.findByText("PAIR cluster model"))
    expect(row.querySelector("svg")).toBeNull()
    fireEvent.click(row)
    expect(api.selectModel).toHaveBeenCalledWith("ollama:qwen3:32b")

    // The catalog refetch after selection reports the new active model.
    catalog = [{ ...PAIR_ITEM, active: true }]
    await waitFor(() => {
      const updated = rowButton(screen.getByText("PAIR cluster model"))
      expect(updated.querySelector("svg")).not.toBeNull()
    })
  })

  it("back returns to the path cards", async () => {
    await renderApp(fakeApi())
    fireEvent.click(await screen.findByRole("button", { name: /On this Mac/ }))
    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    expect(await screen.findByText(/Your personal AI agent, powered by open models/)).toBeTruthy()
  })
})
