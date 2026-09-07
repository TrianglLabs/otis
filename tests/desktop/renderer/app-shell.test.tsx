// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DesktopApi, DesktopSnapshot } from "../../../src/desktop/contracts.js"
import { App } from "../../../src/desktop/renderer/App.js"
import { DesktopProvider } from "../../../src/desktop/renderer/runtime.js"
import { DesktopViewStore } from "../../../src/desktop/renderer/state.js"

/**
 * The shell regression: routing to Settings must not unmount the conversation column, or the composer's unsent
 * draft (and the transcript's scroll position and expanded cards) are thrown away.
 */

const SNAPSHOT: DesktopSnapshot = {
  busy: false,
  phase: "idle",
  model: { id: "openai/gpt-oss-20b", provider: "fireworks", displayName: "gpt-oss 20B" },
  modelState: "ready",
  modelError: undefined,
  session: { id: "session-1", title: "Test session" },
  sessions: [{ id: "session-1", title: "Test session", detail: "just now", active: true }],
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
  fastServing: { available: false, enabled: false },
  hostedConfigured: true,
  pairConfigured: false,
  pairEndpoints: {},
  debug: false,
  platform: "darwin",
  version: "0.0.0-test",
  workspace: { label: "otis", path: "/tmp/otis" },
  entries: [],
  revision: 1,
}

function fakeApi(overrides: Partial<DesktopApi> = {}): DesktopApi {
  return {
    getSnapshot: vi.fn(async () => SNAPSHOT),
    sendPrompt: vi.fn(async () => ({ accepted: true as const, delivery: "started" as const })),
    stop: vi.fn(async () => {}),
    respondToPermission: vi.fn(async () => {}),
    selectSession: vi.fn(async () => ({ ok: true as const })),
    startNewSession: vi.fn(async () => ({ ok: true as const })),
    deleteSession: vi.fn(async () => ({ ok: true as const })),
    listModels: vi.fn(async () => []),
    selectModel: vi.fn(async () => ({ ok: true as const })),
    cancelModelSelection: vi.fn(async () => {}),
    getSubagentTrace: vi.fn(async () => []),
    setAgentsPanelVisible: vi.fn(async () => {}),
    setTheme: vi.fn(async () => {}),
    setThinkingVisible: vi.fn(async () => {}),
    setFastServing: vi.fn(async () => ({ ok: true as const })),
    openFireworksKeyPage: vi.fn(async () => {}),
    setFireworksApiKey: vi.fn(async () => ({ ok: true as const })),
    connectPairEndpoints: vi.fn(async () => ({ ok: true as const })),
    listDownloadedModels: vi.fn(async () => []),
    deleteLocalModel: vi.fn(async () => ({ ok: true as const })),
    setDebugMode: vi.fn(async () => {}),
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
  return store
}

afterEach(() => cleanup())

describe("AppShell settings navigation", () => {
  it("keeps the composer's unsent draft when settings is opened and closed", async () => {
    await renderApp(fakeApi())

    const textarea = screen.getByLabelText("Prompt") as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: "refactor the view store" } })
    expect(textarea.value).toBe("refactor the view store")

    // Open Settings from the sidebar gear: the page takes over the window…
    fireEvent.click(screen.getByRole("button", { name: "Settings" }))
    await act(async () => {}) // flush SettingsPage's listDownloadedModels effect
    expect(screen.getByText("Providers")).toBeTruthy()

    // …but the conversation column is hidden, not unmounted: the very same textarea node stays in the document.
    expect(textarea.isConnected).toBe(true)
    expect(textarea.closest(".mainColumn")?.classList.contains("mainColumn-hidden")).toBe(true)
    expect(textarea.value).toBe("refactor the view store")

    // Closing settings restores the conversation with the draft intact — same element, no remount.
    fireEvent.click(screen.getByRole("button", { name: /close settings/i }))
    const restored = screen.getByLabelText("Prompt") as HTMLTextAreaElement
    expect(restored).toBe(textarea)
    expect(restored.value).toBe("refactor the view store")
    expect(restored.closest(".mainColumn")?.classList.contains("mainColumn-hidden")).toBe(false)
  })
})
