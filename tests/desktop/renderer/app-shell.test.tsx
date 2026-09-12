// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { GlobalSessionPickerItem } from "../../../src/app/global-sessions.js"
import type { TranscriptEntry } from "../../../src/app/transcript.js"
import type { ModelPickerItem } from "../../../src/inference/picker-catalog.js"

const WS = "/ws"

// Happy DOM has no layout/scroll measurements. Shell tests exercise the rows and footer; the production
// virtualizer, scrolling, and bounded DOM are covered by `bun run test:desktop:ui` in real Electron.
vi.mock("react-virtuoso", () => ({
  Virtuoso: ({
    data = [],
    itemContent,
    className,
    components,
    context,
  }: {
    data?: { id?: number; kind?: string }[]
    itemContent: (index: number, item: unknown) => ReactNode
    className?: string
    components?: { Footer?: (props: { context: unknown }) => ReactNode }
    context: unknown
  }) => (
    <div className={className}>
      {data.map((item, index) => (
        // A run row and its first flattened entry share a numeric id; kind keeps keys unique.
        <div key={`${item.kind ?? "item"}-${item.id ?? index}`}>{itemContent(index, item)}</div>
      ))}
      {components?.Footer ? <components.Footer context={context} /> : null}
    </div>
  ),
}))

function sessionItem(partial: {
  id: string
  title: string
  detail: string
  active?: boolean
  snippet?: string
  workspacePath?: string
}): GlobalSessionPickerItem {
  return {
    dirName: "ws-0123456789ab",
    workspaceLabel: "ws",
    workspacePath: WS,
    ...partial,
  }
}

import type { DesktopApi, DesktopEvent, DesktopSnapshot, DesktopUpdateState } from "../../../src/desktop/contracts.js"
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
  needsWorkspace: false,
  sessions: [
    {
      id: "session-1",
      title: "Test session",
      detail: "just now",
      active: true,
      dirName: "ws-0123456789ab",
      workspaceLabel: "ws",
      workspacePath: "/ws",
    },
  ],
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
  hostedConfigured: true,
  pairConfigured: false,
  pairEndpoints: {},
  debug: false,
  platform: "darwin",
  version: "0.0.0-test",
  update: { status: "idle" },
  workspace: { label: "ws", path: "/ws" },
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
    openSessionAt: vi.fn(async () => ({ ok: true as const })),
    openWorkspace: vi.fn(async () => ({ ok: true as const })),
    locateWorkspace: vi.fn(async () => ({ ok: true as const })),
    pickWorkspaceFolder: vi.fn(async () => undefined),
    registerWorkspace: vi.fn(async () => ({ ok: true as const })),
    refreshSessions: vi.fn(async () => {}),
    listModels: vi.fn(async () => []),
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
  return store
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute("data-theme")
})

describe("AppShell settings navigation", () => {
  it("keeps the composer's unsent draft when settings is opened and closed", async () => {
    await renderApp(fakeApi())

    const textarea = screen.getByLabelText("Prompt") as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: "refactor the view store" } })
    expect(textarea.value).toBe("refactor the view store")

    // Open Settings from the header gear: the page takes over the window…
    fireEvent.click(screen.getByRole("button", { name: "Settings" }))
    await act(async () => {}) // flush SettingsPage's mount effects
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

  it("changes the interactive permission mode from Settings", async () => {
    const api = fakeApi({
      getSnapshot: vi.fn(async () => ({ ...SNAPSHOT, permissionMode: "ask" as const })),
      setPermissionMode: vi.fn(async () => {}),
    })
    await renderApp(api)

    fireEvent.click(screen.getByRole("button", { name: "Settings" }))
    await act(async () => {})
    expect(screen.getByText("Security")).toBeTruthy()
    const select = screen.getByRole("combobox", { name: "Permission mode" }) as HTMLSelectElement
    expect(select.value).toBe("ask")
    expect(Array.from(select.options, (option) => option.text)).toEqual(["Ask", "Auto"])

    fireEvent.change(select, { target: { value: "auto" } })
    expect(api.setPermissionMode).toHaveBeenCalledExactlyOnceWith("auto")
  })

  it("deletes a downloaded local model from the model catalog with confirmation", async () => {
    const cached: ModelPickerItem = {
      kind: "model",
      provider: "local",
      id: "Qwen/Qwen3-Coder-30B-A3B-Instruct",
      displayName: "Qwen3 Coder 30B",
      contextLength: 32_768,
      supportsImageInput: false,
      available: true,
      availabilityLabel: "32K · Q4_K_M · 18 GB",
      recommended: false,
      downloaded: true,
      active: false,
    }
    const uncached: ModelPickerItem = {
      kind: "model",
      provider: "local",
      id: "openai/gpt-oss-120b",
      displayName: "gpt-oss 120B",
      contextLength: 65_536,
      supportsImageInput: false,
      available: true,
      availabilityLabel: "Est. 64K · MXFP4 · 63 GB",
      recommended: false,
      downloaded: false,
      active: false,
    }
    const overBudget: ModelPickerItem = {
      // Cached on a bigger machine: too large to run here, but the weights can still be deleted.
      kind: "model",
      provider: "local",
      id: "zai-org/GLM-5.3",
      displayName: "GLM-5.3",
      contextLength: 65_536,
      supportsImageInput: false,
      available: false,
      availabilityLabel: "Needs 390 GB",
      recommended: false,
      downloaded: true,
      active: false,
    }
    let catalog: ModelPickerItem[] = [cached, uncached, overBudget]
    // Deletion stays pending until the test resolves it, like a real multi-GB removal.
    let resolveDelete: ((result: { ok: true }) => void) | undefined
    const deleteLocalModel = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          resolveDelete = resolve
        }),
    )
    const api = fakeApi({
      listModels: vi.fn(async () => catalog),
      deleteLocalModel,
    })
    await renderApp(api)

    // Open the catalog from the composer's model chip.
    fireEvent.click(screen.getByRole("button", { name: "gpt-oss 20B" }))
    await act(async () => {})
    // The catalog opens with the same borderless title bar as the coworker trace overlay.
    expect(screen.getByText("Select a model")).toBeTruthy()

    // Downloaded managed-local rows carry the delete affordance — including the over-budget cache,
    // which cannot run on this machine but can still be freed.
    expect(screen.getByRole("button", { name: "Delete Qwen3 Coder 30B" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Delete GLM-5.3" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Delete gpt-oss 120B" })).toBeNull()
    // The over-budget row is listed with selection disabled.
    const overBudgetSelect = screen
      .getByText(/Needs 390 GB/)
      .closest(".modelPicker-row")
      ?.querySelector(".modelPicker-select")
    expect((overBudgetSelect as HTMLButtonElement).disabled).toBe(true)

    // Requesting deletion replaces the row with a confirmation.
    fireEvent.click(screen.getByRole("button", { name: "Delete Qwen3 Coder 30B" }))
    expect(screen.getByText("Delete Qwen3 Coder 30B?")).toBeTruthy()

    // The first Escape cancels the confirmation, not the catalog.
    fireEvent.keyDown(window, { key: "Escape" })
    expect(screen.queryByText("Delete Qwen3 Coder 30B?")).toBeNull()
    expect(screen.getByRole("dialog", { name: "Select a model" })).toBeTruthy()

    // Keep backs out without touching the disk.
    fireEvent.click(screen.getByRole("button", { name: "Delete Qwen3 Coder 30B" }))
    fireEvent.click(screen.getByRole("button", { name: "Keep" }))
    expect(deleteLocalModel).not.toHaveBeenCalled()

    // Confirming hands the removal to the main process; until it settles, the row shows progress and
    // every conflicting control is disabled.
    fireEvent.click(screen.getByRole("button", { name: "Delete Qwen3 Coder 30B" }))
    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    await act(async () => {})
    expect(deleteLocalModel).toHaveBeenCalledWith("Qwen/Qwen3-Coder-30B-A3B-Instruct")
    expect(screen.getByText("Deleting Qwen3 Coder 30B…")).toBeTruthy()
    expect((screen.getByRole("button", { name: "Delete GLM-5.3" }) as HTMLButtonElement).disabled).toBe(true)
    const uncachedSelect = screen
      .getByText(/Est\. 64K · MXFP4 · 63 GB/)
      .closest(".modelPicker-row")
      ?.querySelector(".modelPicker-select")
    expect((uncachedSelect as HTMLButtonElement).disabled).toBe(true)
    expect(api.listModels).toHaveBeenCalledTimes(1) // no refetch while the deletion is pending

    // The removal settles: the catalog refetches and the disabled controls come back.
    catalog = catalog.map((item) =>
      "downloaded" in item && item.id === cached.id ? { ...item, downloaded: false } : item,
    )
    await act(async () => {
      resolveDelete?.({ ok: true })
    })
    await act(async () => {})
    expect(api.listModels).toHaveBeenCalledTimes(2)
    expect(screen.queryByText("Deleting Qwen3 Coder 30B…")).toBeNull()
    // The row is back to its downloadable state: no delete affordance, name still listed, selection live.
    expect(screen.queryByRole("button", { name: "Delete Qwen3 Coder 30B" })).toBeNull()
    expect(screen.getByText("Qwen3 Coder 30B")).toBeTruthy()
    expect((uncachedSelect as HTMLButtonElement).disabled).toBe(false)

    // The title bar's close button dismisses the catalog, like the trace overlay's header.
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Select a model" })).getByRole("button", {
        name: "Close model picker",
      }),
    )
    await act(async () => {})
    expect(screen.queryByRole("dialog", { name: "Select a model" })).toBeNull()
  })

  it("shows the Debug mode toggle only outside production builds", async () => {
    await renderApp(fakeApi())
    fireEvent.click(screen.getByRole("button", { name: "Settings" }))
    await act(async () => {})
    expect(screen.getByRole("switch", { name: "Toggle debug mode" })).toBeTruthy()

    cleanup()
    vi.stubEnv("PROD", true)
    try {
      await renderApp(fakeApi())
      fireEvent.click(screen.getByRole("button", { name: "Settings" }))
      await act(async () => {})
      expect(screen.queryByRole("switch", { name: "Toggle debug mode" })).toBeNull()
      // Only the debug row is gated; the rest of the Behavior section stays.
      expect(screen.getByRole("switch", { name: "Show or hide model thinking traces" })).toBeTruthy()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("shows an update chip only when an update is downloaded", async () => {
    const api = fakeApi()
    await renderApp(api)
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull()
    cleanup()

    const updated = fakeApi({
      getSnapshot: vi.fn(async () => ({ ...SNAPSHOT, update: { status: "ready" as const, version: "9.9.9" } })),
    })
    await renderApp(updated)
    fireEvent.click(await screen.findByRole("button", { name: "Update" }))
    expect(updated.installUpdate).toHaveBeenCalled()
  })

  it("checks for updates only from Settings and keeps download progress when Settings reopens", async () => {
    let emit!: (event: DesktopEvent) => void
    let finish!: () => void
    const api = fakeApi({
      checkForUpdates: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve
          }),
      ),
      subscribe: vi.fn((listener) => {
        emit = listener
        return () => {}
      }),
    })
    await renderApp(api)
    expect(screen.queryByRole("button", { name: "Check for updates" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Settings" }))
    await act(async () => {})
    expect(screen.getByText("0.0.0-test")).toBeTruthy()
    expect(api.checkForUpdates).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }))
    expect(api.checkForUpdates).toHaveBeenCalledOnce()
    expect((screen.getByRole("button", { name: "Checking…" }) as HTMLButtonElement).disabled).toBe(true)
    act(() =>
      emit({
        type: "status",
        revision: 2,
        status: { ...SNAPSHOT, update: { status: "downloading", version: "9.9.9" } },
      }),
    )
    expect(screen.getByRole("status").textContent).toContain("Downloading Otis 9.9.9")
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /close settings/i }))
    fireEvent.click(screen.getByRole("button", { name: "Settings" }))
    await act(async () => {})
    expect((screen.getByRole("button", { name: "Downloading…" }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => {
      emit({ type: "status", revision: 3, status: { ...SNAPSHOT, update: { status: "ready", version: "9.9.9" } } })
      finish()
    })
    expect(screen.queryByRole("status")).toBeNull()
    expect(screen.getByRole("button", { name: "Update" })).toBeTruthy()
    expect(api.installUpdate).not.toHaveBeenCalled()
  })

  it.each<{ update: DesktopUpdateState; message: string; disabled: boolean }>([
    {
      update: { status: "error", message: "The update couldn’t be downloaded. Please try again." },
      message: "The update couldn’t be downloaded. Please try again.",
      disabled: false,
    },
    {
      update: { status: "unavailable" },
      message: "Update checks aren’t available in this build of Otis.",
      disabled: true,
    },
  ])("shows $update.status update feedback in Settings", async ({ update, message, disabled }) => {
    await renderApp(fakeApi({ getSnapshot: vi.fn(async () => ({ ...SNAPSHOT, update })) }))
    fireEvent.click(screen.getByRole("button", { name: "Settings" }))
    await act(async () => {})
    expect(screen.getByRole("status").textContent).toBe(message)
    expect((screen.getByRole("button", { name: "Check for updates" }) as HTMLButtonElement).disabled).toBe(disabled)
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull()
  })

  it("shows a failed bridge request and lets the user retry to an up-to-date result", async () => {
    let emit!: (event: DesktopEvent) => void
    const check = vi.fn<DesktopApi["checkForUpdates"]>().mockRejectedValueOnce(new Error("bridge unavailable"))
    const api = fakeApi({
      checkForUpdates: check,
      subscribe: vi.fn((listener) => {
        emit = listener
        return () => {}
      }),
    })
    await renderApp(api)
    fireEvent.click(screen.getByRole("button", { name: "Settings" }))
    await act(async () => {})
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Check for updates" })))
    expect(screen.getByRole("status").textContent).toBe("Couldn’t check for updates. Please try again.")
    check.mockImplementationOnce(async () => {
      emit({ type: "status", revision: 2, status: { ...SNAPSHOT, update: { status: "current" } } })
    })
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Check for updates" })))
    expect(check).toHaveBeenCalledTimes(2)
    expect(screen.getByRole("status").textContent).toBe("You’re up to date.")
  })

  it("stays quiet about being current until the user checks for updates", async () => {
    const api = fakeApi({
      getSnapshot: vi.fn(async () => ({ ...SNAPSHOT, update: { status: "current" as const } })),
    })
    await renderApp(api)
    fireEvent.click(screen.getByRole("button", { name: "Settings" }))
    await act(async () => {})
    expect(screen.queryByRole("status")).toBeNull()
  })

  it("lists every session in the palette — no recents cap", async () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      sessionItem({ id: `session-${i}`, title: `Session number ${i}`, detail: "just now", active: i === 0 }),
    )
    const api = fakeApi({ getSnapshot: vi.fn(async () => ({ ...SNAPSHOT, sessions: many })) })
    await renderApp(api)
    fireEvent.keyDown(window, { key: "k", metaKey: true })
    const palette = within(await screen.findByRole("dialog"))
    expect(palette.getByText("Session number 11")).toBeTruthy()
  })

  it("opens the ⌘K palette, searches sessions, and opens the picked session", async () => {
    const hit = sessionItem({
      id: "session-2",
      title: "Refactor the view store",
      detail: "2h ago",
      snippet: "…keep selectors stable…",
    })
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

    expect(api.selectSession).toHaveBeenCalledWith("session-2", "ws-0123456789ab")
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
    const alpha = sessionItem({ id: "session-alpha", title: "Alpha session", detail: "1h ago" })
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
    const hit = sessionItem({ id: "session-z", title: "Zephyr notes", detail: "1d ago" })
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
    expect(api.selectSession).toHaveBeenCalledWith("session-z", "ws-0123456789ab")
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
    const status = await screen.findByRole("status")
    expect(status.textContent).toBe("Thinking…")
    expect(status.closest(".reasoning-text")).not.toBeNull()
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
    expect(api.deleteSession).toHaveBeenCalledWith("session-1", "ws-0123456789ab")
  })
})

describe("global session history", () => {
  it.each([
    { name: "another workspace", workspacePath: "/other/project" },
    { name: "an unknown workspace", workspacePath: undefined },
  ])("allows confirmed deletion from $name without opening its folder", async ({ workspacePath }) => {
    const item = sessionItem({ id: "foreign", title: "Foreign history", detail: "1d ago", workspacePath })
    item.dirName = "foreign-0123456789ab"
    const api = fakeApi({ getSnapshot: vi.fn(async () => ({ ...SNAPSHOT, sessions: [item] })) })
    await renderApp(api)
    fireEvent.keyDown(window, { key: "k", metaKey: true })
    const palette = within(await screen.findByRole("dialog"))

    fireEvent.contextMenu(palette.getByText("Foreign history"))
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete session" }))
    expect(api.deleteSession).not.toHaveBeenCalled()
    fireEvent.click(palette.getByRole("button", { name: "Delete" }))
    await act(async () => {})

    expect(api.deleteSession).toHaveBeenCalledWith("foreign", item.dirName)
    expect(api.openSessionAt).not.toHaveBeenCalled()
    expect(api.selectSession).not.toHaveBeenCalled()
    expect(api.pickWorkspaceFolder).not.toHaveBeenCalled()
  })

  it("removes only the deleted search result when different folders share a session id", async () => {
    const first = sessionItem({ id: "default", title: "First shared history", detail: "1d ago" })
    const second = { ...first, dirName: "other-0123456789ab", title: "Second shared history", workspacePath: "/other" }
    const api = fakeApi({ searchSessions: vi.fn(async () => [first, second]) })
    await renderApp(api)
    fireEvent.keyDown(window, { key: "k", metaKey: true })
    const palette = within(await screen.findByRole("dialog"))
    fireEvent.change(palette.getByRole("textbox"), { target: { value: "shared" } })

    fireEvent.contextMenu(await palette.findByText(second.title))
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete session" }))
    fireEvent.click(palette.getByRole("button", { name: "Delete" }))
    await act(async () => {})

    expect(api.deleteSession).toHaveBeenCalledWith("default", second.dirName)
    expect(palette.queryByText(second.title)).toBeNull()
    expect(palette.getByText(first.title)).toBeTruthy()
  })

  it.each(["locked", "failed"])("keeps foreign history visible and explains a %s deletion", async (failure) => {
    const item = sessionItem({ id: "foreign", title: "Foreign history", detail: "1d ago", workspacePath: "/other" })
    const reason =
      failure === "locked" ? "That session is open in another Otis window." : "Could not remove the session file."
    const api = fakeApi({
      getSnapshot: vi.fn(async () => ({ ...SNAPSHOT, sessions: [item] })),
      deleteSession: vi.fn(async () => {
        if (failure === "failed") throw new Error(reason)
        return { ok: false as const, reason }
      }),
    })
    await renderApp(api)
    fireEvent.keyDown(window, { key: "k", metaKey: true })
    const palette = within(await screen.findByRole("dialog"))
    fireEvent.contextMenu(palette.getByText(item.title))
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete session" }))
    fireEvent.click(palette.getByRole("button", { name: "Delete" }))
    await act(async () => {})
    expect(palette.getByText(reason)).toBeTruthy()
    expect(palette.getByText(item.title)).toBeTruthy()
  })

  it("refreshes history when the palette opens", async () => {
    const api = fakeApi()
    await renderApp(api)
    fireEvent.keyDown(window, { key: "k", metaKey: true })
    await screen.findByRole("dialog")
    expect(api.refreshSessions).toHaveBeenCalled()
  })

  it("labels sessions from other workspaces and opens them via openSessionAt", async () => {
    const foreign = sessionItem({
      id: "session-foreign",
      title: "Notes cleanup",
      detail: "1d ago",
      workspacePath: "/other/notes",
    })
    foreign.workspaceLabel = "notes"
    const api = fakeApi({ getSnapshot: vi.fn(async () => ({ ...SNAPSHOT, sessions: [foreign] })) })
    await renderApp(api)

    fireEvent.keyDown(window, { key: "k", metaKey: true })
    const palette = within(await screen.findByRole("dialog"))

    fireEvent.click(palette.getByText("Notes cleanup"))
    await act(async () => {})
    expect(api.openSessionAt).toHaveBeenCalledWith("/other/notes", "session-foreign", "ws-0123456789ab")
    expect(api.selectSession).not.toHaveBeenCalled()
  })

  it("opens history without a registered folder in place — no folder dialog first", async () => {
    const legacy = sessionItem({ id: "session-legacy", title: "Old stuff", detail: "2w ago" })
    delete legacy.workspacePath
    legacy.workspaceLabel = "oldstuff"
    legacy.dirName = "oldstuff-0123456789ab"
    const api = fakeApi({
      getSnapshot: vi.fn(async () => ({ ...SNAPSHOT, sessions: [legacy] })),
      pickWorkspaceFolder: vi.fn(async () => "/picked/oldstuff"),
    })
    await renderApp(api)

    fireEvent.keyDown(window, { key: "k", metaKey: true })
    const palette = within(await screen.findByRole("dialog"))
    fireEvent.click(palette.getByText("Old stuff"))
    await act(async () => {})
    await act(async () => {})
    expect(api.pickWorkspaceFolder).not.toHaveBeenCalled()
    expect(api.selectSession).toHaveBeenCalledWith("session-legacy", "oldstuff-0123456789ab")
  })

  it("shows the workspace label beside each session row", async () => {
    const legacy = sessionItem({ id: "session-legacy", title: "Old stuff", detail: "2w ago" })
    delete legacy.workspacePath
    legacy.workspaceLabel = "oldstuff"
    legacy.dirName = "oldstuff-0123456789ab"
    const api = fakeApi({ getSnapshot: vi.fn(async () => ({ ...SNAPSHOT, sessions: [legacy] })) })
    await renderApp(api)

    fireEvent.keyDown(window, { key: "k", metaKey: true })
    const palette = within(await screen.findByRole("dialog"))
    expect(palette.getByText("oldstuff")).toBeTruthy()
  })

  it("locate banner picks a folder and completes the pending session's recovery", async () => {
    const api = fakeApi({
      getSnapshot: vi.fn(async () => ({ ...SNAPSHOT, needsWorkspace: true })),
      pickWorkspaceFolder: vi.fn(async () => "/picked/oldstuff"),
    })
    await renderApp(api)

    fireEvent.click(await screen.findByRole("button", { name: /Locate working folder/ }))
    await act(async () => {})
    await act(async () => {})
    expect(api.openWorkspace).not.toHaveBeenCalled()
    expect(api.locateWorkspace).toHaveBeenCalledWith("/picked/oldstuff")
  })

  it("locate banner shows the failure reason instead of hiding it", async () => {
    const api = fakeApi({
      getSnapshot: vi.fn(async () => ({ ...SNAPSHOT, needsWorkspace: true })),
      pickWorkspaceFolder: vi.fn(async () => "/picked/oldstuff"),
      locateWorkspace: vi.fn(async () => ({
        ok: false as const,
        reason: "That session is open in another Otis window.",
      })),
    })
    await renderApp(api)

    fireEvent.click(await screen.findByRole("button", { name: /Locate working folder/ }))
    await act(async () => {})
    await act(async () => {})
    expect(await screen.findByText(/open in another Otis window/)).toBeTruthy()
  })

  it("opens a folder from the palette action", async () => {
    const api = fakeApi({ pickWorkspaceFolder: vi.fn(async () => "/picked/ws") })
    await renderApp(api)
    fireEvent.keyDown(window, { key: "k", metaKey: true })
    const palette = within(await screen.findByRole("dialog"))
    fireEvent.click(palette.getByText("Open Folder"))
    await act(async () => {})
    await act(async () => {})
    expect(api.openWorkspace).toHaveBeenCalledWith("/picked/ws")
  })

  it("shows the active workspace next to the model in the composer and opens the folder picker from it", async () => {
    const api = fakeApi({ pickWorkspaceFolder: vi.fn(async () => "/picked/elsewhere") })
    await renderApp(api)
    const footer = document.querySelector(".composer-footer")
    expect(footer?.textContent).toContain("ws")
    const chip = footer?.querySelector(".composer-workspace")
    expect(chip).toBeTruthy()
    expect(document.querySelector(".workspaceHeader-workspace")).toBeNull() // moved out of the header
    fireEvent.click(chip as Element)
    await act(async () => {})
    await act(async () => {})
    expect(api.pickWorkspaceFolder).toHaveBeenCalled()
    expect(api.openWorkspace).toHaveBeenCalledWith("/picked/elsewhere")
  })
})

describe("header context meter", () => {
  it("stays hidden on the home screen and appears once a conversation exists", async () => {
    const withTokens: DesktopSnapshot = { ...SNAPSHOT, contextTokens: 12_400 }
    await renderApp(fakeApi({ getSnapshot: vi.fn(async () => withTokens) }))
    expect(document.body.querySelector(".contextMeter")).toBeNull()
    cleanup()

    const inConversation: DesktopSnapshot = {
      ...withTokens,
      entries: [{ id: 1, kind: "message", speaker: "You", text: "hello" }],
    }
    await renderApp(fakeApi({ getSnapshot: vi.fn(async () => inConversation) }))
    expect(document.body.querySelector(".contextMeter")).toBeTruthy()
  })
})

describe("theme application", () => {
  it("applies the workspace theme to the document and remembers it for the next boot", async () => {
    const storage = new Map<string, string>()
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    })
    await renderApp(fakeApi({ getSnapshot: vi.fn(async () => ({ ...SNAPSHOT, theme: "matrix" as const })) }))
    expect(document.documentElement.dataset.theme).toBe("matrix")
    expect(storage.get("otis.theme")).toBe("matrix")
  })
})

describe("tool run condensing", () => {
  const entries = [
    { id: 1, kind: "message", speaker: "You", text: "fix the shell" },
    { id: 2, kind: "tool", speaker: "Tool", text: "Searching files: keydown", activityKind: "file_search" },
    { id: 3, kind: "tool", speaker: "Tool", text: "Reading files: AppShell.tsx", activityKind: "file_read" },
    { id: 4, kind: "tool", speaker: "Tool", text: "Running command: bun test", activityKind: "shell" },
    {
      id: 5,
      kind: "tool",
      speaker: "Tool",
      text: "Editing file: AppShell.tsx",
      activityKind: "file_edit",
      diff: "@@ -1 +1 @@\n-old\n+new",
    },
    { id: 6, kind: "message", speaker: "Otis", text: "Done." },
  ] satisfies TranscriptEntry[]

  it("condenses consecutive tool activity behind one row that expands into list rows on click", async () => {
    await renderApp(fakeApi({ getSnapshot: vi.fn(async () => ({ ...SNAPSHOT, entries })) }))

    // Collapsed: user message, run row, standalone diff card, answer — the run's actions mount nothing.
    expect(document.querySelectorAll(".transcriptEntry")).toHaveLength(4)
    const run = screen.getByRole("button", { name: "3 tool actions, latest: Running command: bun test" })
    expect(screen.queryByText("Searching files: keydown")).toBeNull()
    expect(screen.queryByText("Reading files: AppShell.tsx")).toBeNull()

    // The edit's diff is content, not a summary: it stays standalone outside the run.
    expect(screen.getByText("Editing file: AppShell.tsx")).toBeTruthy()

    fireEvent.click(run)
    // Expanding flattens the actions into ordinary virtualized rows beside the run's row, indented as its.
    expect(document.querySelectorAll(".transcriptEntry")).toHaveLength(7)
    expect(document.querySelectorAll(".transcriptEntry-inRun")).toHaveLength(3)
    expect(screen.getByText("Searching files: keydown")).toBeTruthy()
    expect(screen.getByText("Reading files: AppShell.tsx")).toBeTruthy()
    // The row keeps the latest-action label; the flattened action adds its own row.
    expect(screen.getAllByText("Running command: bun test")).toHaveLength(2)

    fireEvent.click(run)
    expect(document.querySelectorAll(".transcriptEntry")).toHaveLength(4)
    expect(screen.queryByText("Searching files: keydown")).toBeNull()
  })
})
