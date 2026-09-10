// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { SessionPickerItem } from "../../../src/app/session-metadata.js"
import type { DesktopApi, DesktopEvent, DesktopSnapshot } from "../../../src/desktop/contracts.js"
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
    searchSessions: vi.fn(async () => []),
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

    // Open Settings from the header gear: the page takes over the window…
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

  it("lists every session in the palette — no recents cap", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `session-${i}`,
      title: `Session number ${i}`,
      detail: "just now",
      active: i === 0,
    }))
    const api = fakeApi({ getSnapshot: vi.fn(async () => ({ ...SNAPSHOT, sessions: many })) })
    await renderApp(api)
    fireEvent.keyDown(window, { key: "k", metaKey: true })
    const palette = within(await screen.findByRole("dialog"))
    expect(palette.getByText("Session number 11")).toBeTruthy()
  })

  it("opens the ⌘K palette, searches sessions, and opens the picked session", async () => {
    const hit: SessionPickerItem = {
      id: "session-2",
      title: "Refactor the view store",
      detail: "2h ago",
      snippet: "…keep selectors stable…",
    }
    const api = fakeApi({ searchSessions: vi.fn(async () => [hit]) })
    await renderApp(api)

    // ⌘K opens the palette with recents and actions.
    fireEvent.keyDown(window, { key: "k", metaKey: true })
    const input = screen.getByLabelText("Search sessions and actions")
    const palette = within(screen.getByRole("dialog"))
    expect(palette.getByText("Recent sessions")).toBeTruthy()
    expect(palette.getByText("Fresh start")).toBeTruthy()

    vi.useFakeTimers()
    fireEvent.change(input, { target: { value: "zephyr" } })
    act(() => {
      vi.advanceTimersByTime(200)
    })
    await act(async () => {}) // flush the debounced search promise
    vi.useRealTimers()

    expect(api.searchSessions).toHaveBeenCalledWith("zephyr")
    fireEvent.click(screen.getByText("Refactor the view store"))
    await act(async () => {})

    expect(api.selectSession).toHaveBeenCalledWith("session-2")
    expect(screen.queryByLabelText("Search sessions and actions")).toBeNull()
  })

  it("shows the header's Fresh start button only once a conversation exists", async () => {
    await renderApp(fakeApi())
    // Home screen: an empty session is already a fresh start, so the button is redundant.
    expect(screen.queryByRole("button", { name: "Fresh start" })).toBeNull()
    cleanup()

    const withConversation: DesktopSnapshot = {
      ...SNAPSHOT,
      entries: [{ id: 1, kind: "message", speaker: "You", text: "hello" }],
    }
    await renderApp(fakeApi({ getSnapshot: vi.fn(async () => withConversation) }))
    expect(screen.getByRole("button", { name: "Fresh start" })).toBeTruthy()
  })

  it("never opens a result from a stale query", async () => {
    const alpha: SessionPickerItem = { id: "session-alpha", title: "Alpha session", detail: "1h ago" }
    const api = fakeApi({ searchSessions: vi.fn(async (q: string) => (q === "alpha" ? [alpha] : [])) })
    await renderApp(api)

    fireEvent.keyDown(window, { key: "k", metaKey: true })
    const input = screen.getByLabelText("Search sessions and actions")
    const palette = within(screen.getByRole("dialog"))

    vi.useFakeTimers()
    fireEvent.change(input, { target: { value: "alpha" } })
    act(() => {
      vi.advanceTimersByTime(200)
    })
    await act(async () => {})
    expect(palette.getByText("Alpha session")).toBeTruthy()

    // Retype and press Enter before the new search completes: the alpha result is gone, nothing activates.
    fireEvent.change(input, { target: { value: "beta" } })
    expect(palette.queryByText("Alpha session")).toBeNull()
    fireEvent.keyDown(input, { key: "Enter" })
    await act(async () => {})
    expect(api.selectSession).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it("keeps a valid selection when results arrive after an ArrowDown during loading", async () => {
    const hit: SessionPickerItem = { id: "session-z", title: "Zephyr notes", detail: "1d ago" }
    const api = fakeApi({ searchSessions: vi.fn(async () => [hit]) })
    await renderApp(api)

    fireEvent.keyDown(window, { key: "k", metaKey: true })
    const input = screen.getByLabelText("Search sessions and actions")
    const palette = within(screen.getByRole("dialog"))

    vi.useFakeTimers()
    fireEvent.change(input, { target: { value: "zephyr" } })
    // No rows yet: pressing Down must not park the selection at -1.
    fireEvent.keyDown(input, { key: "ArrowDown" })
    act(() => {
      vi.advanceTimersByTime(200)
    })
    await act(async () => {})
    vi.useRealTimers()

    const row = palette.getByText("Zephyr notes").closest(".palette-row")
    expect(row?.classList.contains("palette-row-selected")).toBe(true)
    fireEvent.keyDown(input, { key: "Enter" })
    await act(async () => {})
    expect(api.selectSession).toHaveBeenCalledWith("session-z")
  })

  it("keeps Tab focus inside the palette and restores it to the composer on close", async () => {
    await renderApp(fakeApi())

    const textarea = screen.getByLabelText("Prompt") as HTMLTextAreaElement
    textarea.focus()
    expect(document.activeElement).toBe(textarea)

    fireEvent.keyDown(window, { key: "k", metaKey: true })
    const input = screen.getByLabelText("Search sessions and actions")
    expect(document.activeElement).toBe(input)

    // Shift+Tab on the first focusable wraps to the last instead of escaping to the workspace.
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true })
    const dialog = screen.getByRole("dialog")
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).not.toBe(input)

    fireEvent.keyDown(window, { key: "Escape" })
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(document.activeElement).toBe(textarea)
  })

  it("hides finished traces when the toggle is off, showing live thinking as plain text only", async () => {
    const withThinking: DesktopSnapshot = {
      ...SNAPSHOT,
      thinkingVisible: false,
      entries: [
        { id: 1, kind: "message", speaker: "You", text: "hello" },
        { id: 2, kind: "reasoning", speaker: "Thinking", text: "old finished trace", streaming: false },
        { id: 3, kind: "reasoning", speaker: "Thinking", text: "live current thought", streaming: true },
      ],
    }
    await renderApp(fakeApi({ getSnapshot: vi.fn(async () => withThinking) }))

    expect(screen.queryByText("old finished trace")).toBeNull()
    // Trace content never renders in hidden mode — just the quiet status line.
    expect(screen.queryByText("live current thought")).toBeNull()
    const status = screen.getByText("Thinking…")
    expect(status.classList.contains("reasoning-text")).toBe(true)
    expect(document.querySelector(".reasoning-header")).toBeNull()
    expect(document.querySelector(".reasoning-preview")).toBeNull()
  })

  it("auto-expands the coworkers rail when runs newly appear, but not on a settings remount", async () => {
    let listener: ((event: DesktopEvent) => void) | undefined
    const hiddenNoRuns: DesktopSnapshot = { ...SNAPSHOT, agentsPanelVisible: false, subagents: [] }
    const { entries: _entries, revision: _revision, ...hiddenStatus } = hiddenNoRuns
    const api = fakeApi({
      getSnapshot: vi.fn(async () => hiddenNoRuns),
      subscribe: vi.fn((fn: (event: DesktopEvent) => void) => {
        listener = fn
        return () => {}
      }),
    })
    await renderApp(api)
    expect(api.setAgentsPanelVisible).not.toHaveBeenCalled()

    // Runs arrive while the rail is hidden → the panel asks the runtime to open it.
    const run = { toolCallId: "t1", title: "Survey the shell", status: "running" as const, tools: 0 }
    act(() => listener?.({ type: "status", revision: 2, status: { ...hiddenStatus, subagents: [run] } }))
    expect(api.setAgentsPanelVisible).toHaveBeenCalledWith(true)
    // The runtime applies the preference and echoes it back.
    act(() =>
      listener?.({
        type: "status",
        revision: 3,
        status: { ...hiddenStatus, subagents: [run], agentsPanelVisible: true },
      }),
    )

    // The user hides the rail with the run still present…
    act(() =>
      listener?.({
        type: "status",
        revision: 3,
        status: { ...hiddenStatus, subagents: [run], agentsPanelVisible: false },
      }),
    )
    // …opens and closes Settings, remounting the panel: existing runs must not reopen it.
    act(() => listener?.({ type: "status", revision: 4, status: { ...hiddenStatus, subagents: [run] } }))
    fireEvent.click(screen.getByRole("button", { name: "Settings" }))
    await act(async () => {})
    fireEvent.click(screen.getByRole("button", { name: /close settings/i }))
    await act(async () => {})
    expect(api.setAgentsPanelVisible).toHaveBeenCalledTimes(1)
  })

  it("rings the composer while the agent is working, and only then", async () => {
    await renderApp(fakeApi())
    expect(document.querySelector(".composer-box")?.classList.contains("composer-boxWorking")).toBe(false)
    cleanup()

    const working: DesktopSnapshot = { ...SNAPSHOT, busy: true }
    await renderApp(fakeApi({ getSnapshot: vi.fn(async () => working) }))
    expect(document.querySelector(".composer-box")?.classList.contains("composer-boxWorking")).toBe(true)
  })

  it("deletes a session from the palette via right-click, only after the confirm step", async () => {
    const api = fakeApi()
    await renderApp(api)

    fireEvent.keyDown(window, { key: "k", metaKey: true })
    const palette = within(screen.getByRole("dialog"))

    // The recents list shows the active session; deletion hides behind a right-click context menu.
    fireEvent.contextMenu(palette.getByText("Test session"))
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete session" }))
    expect(palette.getByText("Delete this session?")).toBeTruthy()
    expect(api.deleteSession).not.toHaveBeenCalled()

    // Backing out keeps the session; the confirm state collapses.
    fireEvent.click(palette.getByRole("button", { name: "Keep" }))
    expect(palette.queryByText("Delete this session?")).toBeNull()
    expect(api.deleteSession).not.toHaveBeenCalled()

    fireEvent.contextMenu(palette.getByText("Test session"))
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete session" }))
    fireEvent.click(palette.getByRole("button", { name: "Delete" }))
    await act(async () => {})
    expect(api.deleteSession).toHaveBeenCalledWith("session-1")
  })
})
