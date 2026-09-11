import { Check, CornerDownLeft, FilePlus2, FolderOpen, Trash2 } from "lucide-react"
import { Fragment, useEffect, useRef, useState } from "react"
import type { GlobalSessionPickerItem } from "../../../../app/global-sessions.js"
import { Button } from "../../components/Button.js"
import { Icon } from "../../components/Icon.js"
import { useDesktop, useDesktopState } from "../../runtime.js"
import { useScrollbarFlash } from "../../useScrollbarFlash.js"

type PaletteRow =
  | {
      kind: "action"
      id: string
      label: string
      hint?: string
      icon?: typeof FilePlus2
      run: () => void | Promise<void>
    }
  | { kind: "session"; item: GlobalSessionPickerItem }

function rowKey(item: GlobalSessionPickerItem) {
  return `${item.dirName}:${item.id}`
}

const SEARCH_DEBOUNCE_MS = 150
/**
 * The ⌘K palette: the primary way to move around — session search (title-first, content matches carry a
 * snippet) plus the app-level actions. Sessions are searched through the main process, which owns the
 * workspace's stored JSONL files.
 */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const { api } = useDesktop()
  const state = useDesktopState("sessions", "workspace")
  const [query, setQuery] = useState("")
  const scrollbar = useScrollbarFlash()
  // Results are tagged with the query that produced them — stale hits are never shown or activated.
  const [found, setFound] = useState<{ query: string; items: GlobalSessionPickerItem[] }>()
  const [selected, setSelected] = useState(0)
  const [confirmingDeleteKey, setConfirmingDeleteKey] = useState<string>()
  const [menu, setMenu] = useState<{ key: string; x: number; y: number }>()
  const [actionError, setActionError] = useState<string>()
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const needle = query.trim()

  // Content search is debounced; title-free queries fall back to the recents already in the snapshot.
  useEffect(() => {
    if (!needle) {
      setFound(undefined)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      void api
        .searchSessions(needle)
        .then((items) => {
          if (!cancelled) setFound({ query: needle, items })
        })
        .catch(() => {
          if (!cancelled) setFound({ query: needle, items: [] })
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [needle, api])

  useEffect(() => setSelected(0), [needle])

  // Focus the input on open and give focus back to whatever had it (usually the composer) on close.
  useEffect(() => {
    const previous = document.activeElement
    inputRef.current?.focus()
    return () => {
      if (previous instanceof HTMLElement) previous.focus()
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation()
        // The context menu swallows the first Escape; the second closes the palette.
        if (menu) {
          setMenu(undefined)
          return
        }
        onClose()
        return
      }
      // Modal focus containment: Tab cycles the dialog and its context menu, never the workspace behind them.
      if (event.key === "Tab") {
        const focusables = [
          ...Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("input, button") ?? []),
          ...Array.from(menuRef.current?.querySelectorAll<HTMLElement>("button") ?? []),
        ].filter((element) => !element.hasAttribute("disabled"))
        if (focusables.length === 0) {
          event.preventDefault()
          return
        }
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        const active = document.activeElement
        const outside = !focusables.includes(active as HTMLElement)
        if (event.shiftKey && (active === first || outside)) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && (active === last || outside)) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [onClose, menu])

  // Opening the palette refreshes history: sessions created outside this window (e.g. the TUI) appear.
  useEffect(() => {
    void api.refreshSessions()
  }, [api])

  // Any click outside the context menu dismisses it (its own item handles its click before this fires).
  useEffect(() => {
    if (!menu) return
    const dismiss = () => setMenu(undefined)
    window.addEventListener("mousedown", dismiss)
    return () => window.removeEventListener("mousedown", dismiss)
  }, [menu])

  const allActions: PaletteRow[] = [
    {
      kind: "action",
      id: "new-session",
      label: "Fresh start",
      hint: "⌘N",
      run: () => {
        void api.startNewSession()
        onClose()
      },
    },
    {
      kind: "action",
      id: "open-folder",
      label: "Open Folder",
      icon: FolderOpen,
      run: async () => {
        const path = await api.pickWorkspaceFolder()
        if (!path) return
        setActionError(undefined)
        const result = await api.openWorkspace(path)
        if (result.ok) onClose()
        else setActionError(result.reason)
      },
    },
  ]
  const actions = allActions.filter(
    (action) => action.kind === "action" && (!needle || action.label.toLowerCase().includes(needle.toLowerCase())),
  )

  // Only results tagged with the current query may render; anything else is a stale response.
  const currentResults = needle && found?.query === needle ? found.items : undefined
  // No query shows every session; the list scrolls.
  const sessions = needle ? (currentResults ?? []) : (state?.sessions ?? [])
  const rows: PaletteRow[] = [...actions, ...sessions.map((item): PaletteRow => ({ kind: "session", item }))]
  const selectedRow = rows[Math.min(selected, Math.max(0, rows.length - 1))]

  const activate = async (row: PaletteRow | undefined) => {
    if (!row) return
    if (row.kind === "action") {
      void row.run()
      return
    }
    // A row in its delete-confirm state takes a deliberate mouse click — Enter stays safe.
    if (rowKey(row.item) === confirmingDeleteKey) return
    setActionError(undefined)
    try {
      // Unknown or missing folder: open the history in place; the banner's locate flow takes it from there.
      const result =
        row.item.workspacePath !== undefined && row.item.workspacePath !== state?.workspace.path
          ? await api.openSessionAt(row.item.workspacePath, row.item.id, row.item.dirName)
          : await api.selectSession(row.item.id, row.item.dirName)
      if (result.ok) onClose()
      else setActionError(result.reason)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  const deleteSession = async (id: string, dirName: string) => {
    setConfirmingDeleteKey(undefined)
    setActionError(undefined)
    try {
      const result = await api.deleteSession(id, dirName)
      if (result.ok) {
        // Search results are local state; remove only this storage identity, since ids repeat across folders.
        setFound((current) =>
          current
            ? { ...current, items: current.items.filter((item) => item.id !== id || item.dirName !== dirName) }
            : current,
        )
      } else {
        setActionError(result.reason)
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  const onInputKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      // An empty list clamps to 0, not -1 — rows arriving later must find a valid selection.
      setSelected((index) => Math.min(index + 1, Math.max(0, rows.length - 1)))
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      setSelected((index) => Math.max(index - 1, 0))
    } else if (event.key === "Enter") {
      event.preventDefault()
      void activate(selectedRow)
    }
  }

  // Keep the selected row visible while arrowing through a long list.
  useEffect(() => {
    listRef.current?.querySelector(".palette-row-selected")?.scrollIntoView({ block: "nearest" })
  }, [selected])

  const searching = Boolean(needle) && currentResults === undefined

  return (
    <>
      <button type="button" className="overlayBackdrop" aria-label="Close palette" onClick={onClose} />
      <div className="palette noDrag" role="dialog" aria-modal="true" aria-label="Command palette" ref={dialogRef}>
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder="Search sessions, or pick an action…"
          spellCheck={false}
          autoComplete="off"
          aria-label="Search sessions and actions"
        />
        {actionError ? <div className="palette-message palette-error">{actionError}</div> : null}
        <div
          className={`palette-list${scrollbar.scrolling ? " scrolling" : ""}`}
          ref={listRef}
          onScroll={() => {
            scrollbar.onScroll()
            setMenu(undefined)
          }}
        >
          {rows.map((row, index) => {
            const firstSession = row.kind === "session" && rows[index - 1]?.kind !== "session"
            const key = row.kind === "action" ? row.id : rowKey(row.item)
            return (
              <Fragment key={key}>
                {!needle && index === 0 && row.kind === "action" ? (
                  <div className="palette-section">Actions</div>
                ) : null}
                {!needle && firstSession ? <div className="palette-section">Recent sessions</div> : null}
                {row.kind === "action" ? (
                  <button
                    type="button"
                    className={`palette-row${index === selected ? " palette-row-selected" : ""}`}
                    onMouseEnter={() => setSelected(index)}
                    onClick={() => void activate(row)}
                  >
                    <span className="palette-rowText">
                      <span className="palette-rowTitle">
                        <Icon icon={row.icon ?? FilePlus2} size={12} />
                        {row.label}
                      </span>
                      {row.hint ? <kbd className="palette-kbd">{row.hint}</kbd> : null}
                    </span>
                  </button>
                ) : (
                  <div className={`palette-row${index === selected ? " palette-row-selected" : ""}`}>
                    {confirmingDeleteKey === key ? (
                      <div className="palette-confirm">
                        <span className="palette-confirmText">Delete this session?</span>
                        <Button variant="ghost" size="sm" onClick={() => setConfirmingDeleteKey(undefined)}>
                          Keep
                        </Button>
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => void deleteSession(row.item.id, row.item.dirName)}
                        >
                          Delete
                        </Button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="palette-rowMain"
                        onMouseEnter={() => setSelected(index)}
                        onClick={() => void activate(row)}
                        onContextMenu={(event) => {
                          event.preventDefault()
                          setSelected(index)
                          setMenu({ key, x: event.clientX, y: event.clientY })
                        }}
                      >
                        <span className="palette-rowText">
                          <span className="palette-rowTitle">
                            {row.item.title}
                            {row.item.active ? <Icon icon={Check} size={12} /> : null}
                          </span>
                          <span className="palette-rowWorkspace">{row.item.workspaceLabel}</span>
                          <span className="palette-rowDetail">{row.item.detail}</span>
                          {row.item.snippet ? <span className="palette-rowSnippet">{row.item.snippet}</span> : null}
                        </span>
                      </button>
                    )}
                  </div>
                )}
              </Fragment>
            )
          })}
          {searching ? <div className="palette-empty">Searching…</div> : null}
          {!searching && rows.length === 0 ? <div className="palette-empty">No matching sessions</div> : null}
        </div>
        <div className="palette-footer">
          <Icon icon={CornerDownLeft} size={11} /> to open · ↑↓ to move · esc to close
        </div>
      </div>
      {menu ? (
        // Rendered outside the dialog: the dialog's translateX transform would trap position:fixed inside it.
        <div
          className="palette-menu"
          role="menu"
          ref={menuRef}
          style={{
            left: Math.max(8, Math.min(menu.x, window.innerWidth - 180)),
            top: Math.max(8, Math.min(menu.y, window.innerHeight - 60)),
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            className="palette-menuItem"
            onClick={() => {
              setMenu(undefined)
              setConfirmingDeleteKey(menu.key)
            }}
          >
            <Icon icon={Trash2} size={12} />
            Delete session
          </button>
        </div>
      ) : null}
    </>
  )
}
