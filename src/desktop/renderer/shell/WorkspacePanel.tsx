import {
  Box,
  ChevronRight,
  ChevronsRight,
  FileDiff,
  Frame,
  type LucideIcon,
  SquareTerminal,
  X,
} from "lucide-react"
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import type { TranscriptEntry } from "../../../app/transcript.js"
import { countDiffLines, splitSubject } from "../../../tools/activity.js"
import type { SubagentSummary, ThemeName } from "../../contracts.js"
import { IconButton } from "../components/Button.js"
import { FileTypeIcon } from "../components/FileTypeIcon.js"
import { Icon } from "../components/Icon.js"
import {
  AgentStatus,
  AgentTraceOverlay,
  agentSummary,
} from "../features/agents/AgentTraceOverlay.js"
import { CanvasPanel } from "../features/canvas/CanvasPanel.js"
import type { CanvasView } from "../features/canvas/canvas-context.js"
import { DiffView } from "../features/conversation/ToolCard.js"
import { TerminalView } from "../features/terminal/TerminalView.js"
import { useI18n } from "../i18n/index.js"
import { useDesktop, useDesktopSelector, useScrollbarFlash } from "../runtime.js"

type PanelTab = "coworkers" | "canvas" | "changes" | "terminal"
/** A tool entry that edited a file: the Changes tab lists these by file. */
type Change = TranscriptEntry & { diff: string; activitySubject: string }
export const isChange = (entry: TranscriptEntry): entry is Change =>
  entry.kind === "tool" && entry.diff !== undefined && entry.activitySubject !== undefined
const EMPTY_RUNS: SubagentSummary[] = []
const NO_CHANGES: Change[] = []
const PANEL_MIN_WIDTH = 240
const PANEL_MAX_WIDTH = 720
const MAIN_MIN_WIDTH = 480
const PANEL_KEYBOARD_STEP = 16

/**
 * The session's secondary workspace: delegated runs, the Mermaid block explicitly opened in Canvas,
 * and the workspace shell while one is open.
 */
export function WorkspacePanel({
  views,
  onCloseDiagram,
  terminalFocus,
}: {
  views: CanvasView[]
  onCloseDiagram: () => void
  /** When the shell was last asked for from this window; a change brings its tab forward. */
  terminalFocus: number | undefined
}) {
  // Drags update the local width immediately; the saved width seeds it and survives relaunches.
  // The wrapper tells a double-click reset (width undefined) apart from "never touched".
  const [local, setLocal] = useState<{ width: number | undefined }>()
  // The focused session's edits; the selection compares by entry, so it holds until one lands.
  const changes = useDesktopSelector((snapshot) =>
    (snapshot?.entries ?? NO_CHANGES).filter(isChange),
  )
  const state = useDesktopSelector((snapshot) => ({
    runs: snapshot?.subagents ?? EMPTY_RUNS,
    visible: snapshot?.agentsPanelVisible ?? true,
    theme: snapshot?.theme ?? "default",
    terminal: snapshot?.terminal ?? false,
    savedWidth: snapshot?.workspacePanelWidth,
  }))
  const { savedWidth, ...panel } = state
  return (
    <SessionWorkspacePanel
      changes={changes}
      {...panel}
      views={views}
      onCloseDiagram={onCloseDiagram}
      terminalFocus={terminalFocus}
      railWidth={local ? local.width : savedWidth}
      onRailWidthChange={(width) => setLocal({ width })}
    />
  )
}

function SessionWorkspacePanel({
  runs,
  views,
  onCloseDiagram,
  terminal,
  terminalFocus,
  visible,
  theme,
  railWidth,
  onRailWidthChange,
  changes,
}: {
  runs: SubagentSummary[]
  views: CanvasView[]
  onCloseDiagram: () => void
  terminal: boolean
  terminalFocus: number | undefined
  visible: boolean
  theme: ThemeName
  railWidth: number | undefined
  onRailWidthChange: (width: number | undefined) => void
  changes: Change[]
}) {
  const { api } = useDesktop()
  const { t } = useI18n()
  const [pickedTab, setPickedTab] = useState<PanelTab>(views.length > 0 ? "canvas" : "coworkers")
  // The document that last took the view shows, unless the user picked another one since.
  const [chosen, setChosen] = useState<{ key: string; at: number }>()
  const latest = views.reduce<CanvasView | undefined>(
    (best, view) => (!best || view.activated > best.activated ? view : best),
    undefined,
  )
  const selected =
    latest &&
    ((chosen && chosen.at >= latest.activated && views.find((v) => v.key === chosen.key)) || latest)
  // A tab exists while it has something to show; the rail itself leaves with the last one.
  const openTabs: readonly PanelTab[] = [
    ...(runs.length > 0 ? ["coworkers" as const] : []),
    ...(selected ? ["canvas" as const] : []),
    ...(changes.length > 0 ? ["changes" as const] : []),
    ...(terminal ? ["terminal" as const] : []),
  ]
  const activeTab = openTabs.includes(pickedTab) ? pickedTab : (openTabs[0] ?? "coworkers")
  // A trace belongs to the session whose runs are listed; focus moving elsewhere closes it.
  const [chosenTraceId, setOpenTraceId] = useState<string>()
  const openTraceId = runs.some((run) => run.toolCallId === chosenTraceId)
    ? chosenTraceId
    : undefined
  const [resizing, setResizing] = useState(false)
  const panelId = useId()
  const [contentMinWidth, setContentMinWidth] = useState(PANEL_MIN_WIDTH)
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  const panelRef = useRef<HTMLElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)
  const tabsRef = useRef<HTMLDivElement>(null)
  const stopResizeRef = useRef<() => void>(() => {})
  const hasContent = openTabs.length > 0

  useEffect(() => () => stopResizeRef.current(), [])
  useEffect(() => {
    const updateViewport = () => setViewportWidth(window.innerWidth)
    window.addEventListener("resize", updateViewport)
    return () => window.removeEventListener("resize", updateViewport)
  }, [])

  useEffect(() => {
    if (!visible || !hasContent) stopResizeRef.current()
  }, [visible, hasContent])

  useLayoutEffect(() => {
    const header = headerRef.current
    const tabs = tabsRef.current
    const collapse = header?.querySelector<HTMLElement>(":scope > .iconBtn")
    if (!header || !tabs || !collapse) return
    const measure = () => {
      const styles = getComputedStyle(header)
      const horizontalPadding =
        (Number.parseFloat(styles.paddingLeft) || 0) + (Number.parseFloat(styles.paddingRight) || 0)
      const gap = Number.parseFloat(styles.columnGap || styles.gap) || 0
      const border = panelRef.current
        ? Number.parseFloat(getComputedStyle(panelRef.current).borderLeftWidth) || 0
        : 0
      const tabsWidth = tabs.getBoundingClientRect().width || tabs.scrollWidth
      const collapseWidth = collapse.getBoundingClientRect().width || collapse.offsetWidth
      setContentMinWidth(
        Math.max(
          PANEL_MIN_WIDTH,
          Math.ceil(horizontalPadding + gap + border + tabsWidth + collapseWidth),
        ),
      )
    }
    measure()
    // Intrinsic tab widths also change when fonts finish loading or the display scale changes.
    const observer = new ResizeObserver(measure)
    observer.observe(tabs)
    observer.observe(collapse)
    return () => observer.disconnect()
  }, [hasContent, activeTab, t, theme, visible])

  // A coworker starting brings Coworkers forward and a document taking the view brings Canvas
  // forward; either reopens a hidden rail. Remounting with existing work changes nothing.
  const seenRuns = useRef(runs.length)
  useEffect(() => {
    const previous = seenRuns.current
    seenRuns.current = runs.length
    if (runs.length <= previous) return
    setPickedTab("coworkers")
    if (!visible) void api.setAgentsPanelVisible(true)
  }, [runs.length, visible, api])

  const latestActivated = latest?.activated
  const seenActivated = useRef(latestActivated)
  useEffect(() => {
    const previous = seenActivated.current
    seenActivated.current = latestActivated
    if (latestActivated === undefined || latestActivated === previous) return
    setPickedTab("canvas")
    if (!visible) void api.setAgentsPanelVisible(true)
  }, [latestActivated, visible, api])

  // Asking for the shell brings its tab forward the same way.
  const seenTerminalFocus = useRef(terminalFocus)
  useEffect(() => {
    const previous = seenTerminalFocus.current
    seenTerminalFocus.current = terminalFocus
    if (terminalFocus === undefined || terminalFocus === previous) return
    setPickedTab("terminal")
    if (!visible) void api.setAgentsPanelVisible(true)
  }, [terminalFocus, visible, api])

  const maxWidth = Math.max(
    contentMinWidth,
    Math.min(PANEL_MAX_WIDTH, viewportWidth - MAIN_MIN_WIDTH),
  )
  const defaultWidth =
    activeTab === "coworkers" ? 320 : Math.min(560, Math.max(280, Math.round(viewportWidth * 0.38)))
  const clampWidth = (width: number) =>
    Math.min(maxWidth, Math.max(contentMinWidth, Math.round(width)))
  const effectiveWidth = clampWidth(railWidth ?? defaultWidth)
  const clampWidthRef = useRef(clampWidth)
  useLayoutEffect(() => {
    clampWidthRef.current = clampWidth
  })

  const startResize = (event: PointerEvent<HTMLHRElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    stopResizeRef.current()
    const measuredWidth = panelRef.current?.getBoundingClientRect().width ?? 0
    const startWidth = measuredWidth > 0 ? measuredWidth : effectiveWidth
    const startX = event.clientX
    const pointerId = event.pointerId
    const handle = event.currentTarget
    handle.focus()
    handle.setPointerCapture(pointerId)
    setResizing(true)
    const move = (moveEvent: globalThis.PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return
      onRailWidthChange(clampWidthRef.current(startWidth + startX - moveEvent.clientX))
    }
    const stop = (stopEvent?: globalThis.PointerEvent) => {
      if (stopEvent && stopEvent.pointerId !== pointerId) return
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", stop)
      window.removeEventListener("pointercancel", stop)
      window.removeEventListener("blur", cancel)
      handle.removeEventListener("lostpointercapture", stop)
      stopResizeRef.current = () => {}
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId)
      setResizing(false)
    }
    const cancel = () => stop()
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", stop)
    window.addEventListener("pointercancel", stop)
    window.addEventListener("blur", cancel)
    handle.addEventListener("lostpointercapture", stop)
    stopResizeRef.current = stop
  }

  // Persist once a drag settles or a keyboard/double-click change lands, never on mount.
  const persistedWidth = useRef(railWidth)
  useEffect(() => {
    if (resizing || railWidth === persistedWidth.current) return
    persistedWidth.current = railWidth
    void api.setWorkspacePanelWidth(railWidth)
  }, [railWidth, resizing, api])

  const selectTabWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = openTabs.indexOf(activeTab)
    let next: number
    if (event.key === "ArrowRight") next = (index + 1) % openTabs.length
    else if (event.key === "ArrowLeft") next = (index + openTabs.length - 1) % openTabs.length
    else if (event.key === "Home") next = 0
    else if (event.key === "End") next = openTabs.length - 1
    else return
    event.preventDefault()
    setPickedTab(openTabs[next])
    tabsRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
  }

  const resizeWithKeyboard = (event: KeyboardEvent<HTMLHRElement>) => {
    let width: number | undefined
    if (event.key === "ArrowLeft") width = effectiveWidth + PANEL_KEYBOARD_STEP
    else if (event.key === "ArrowRight") width = effectiveWidth - PANEL_KEYBOARD_STEP
    else if (event.key === "Home") width = contentMinWidth
    else if (event.key === "End") width = maxWidth
    else return
    event.preventDefault()
    onRailWidthChange(clampWidth(width))
  }

  if (!hasContent) return null
  const canvasClass = activeTab === "canvas" ? " workspaceRail-canvas" : ""
  const hiddenClass = visible ? "" : " workspaceRail-hidden"
  const resizingClass = resizing ? " workspaceRail-resizing" : ""
  const viewClass = (tab: PanelTab) => {
    const active = activeTab === tab ? " workspaceRail-view-active" : ""
    return `workspaceRail-view workspaceRail-view-${tab}${active}`
  }
  const tab = (name: PanelTab, icon: LucideIcon, label: string) => (
    <button
      type="button"
      role="tab"
      id={`${panelId}-tab-${name}`}
      aria-selected={activeTab === name}
      aria-controls={`${panelId}-view-${name}`}
      tabIndex={activeTab === name ? 0 : -1}
      onClick={() => setPickedTab(name)}
    >
      <Icon icon={icon} size={13} />
      {label}
    </button>
  )
  const view = (name: PanelTab) => ({
    className: viewClass(name),
    role: "tabpanel",
    id: `${panelId}-view-${name}`,
    "aria-labelledby": `${panelId}-tab-${name}`,
    "aria-hidden": activeTab !== name,
  })
  return (
    <>
      <aside
        ref={panelRef}
        className={`workspaceRail${canvasClass}${hiddenClass}${resizingClass}`}
        aria-label={t("panel.workspacePanel")}
        aria-hidden={!visible}
        inert={visible ? undefined : true}
        style={
          {
            "--workspace-rail-width": `${effectiveWidth}px`,
          } as CSSProperties
        }
        onKeyDown={(event) => {
          if (event.key !== "Escape" || event.defaultPrevented) return
          event.preventDefault()
          void api.setAgentsPanelVisible(false)
        }}
      >
        <hr
          className="workspaceRail-resizeHandle noDrag"
          aria-label={t("panel.resizeSidePanel")}
          aria-orientation="vertical"
          aria-valuemin={contentMinWidth}
          aria-valuemax={maxWidth}
          aria-valuenow={Math.round(effectiveWidth)}
          tabIndex={0}
          title={t("panel.resizeSidePanel")}
          onDoubleClick={() => onRailWidthChange(undefined)}
          onKeyDown={resizeWithKeyboard}
          onPointerDown={startResize}
        />
        <div ref={headerRef} className="workspaceRail-header">
          <div
            ref={tabsRef}
            className="workspaceRail-tabs noDrag"
            role="tablist"
            aria-label={t("panel.workspaceViews")}
            onKeyDown={selectTabWithKeyboard}
          >
            {runs.length > 0 ? tab("coworkers", Box, t("panel.coworkers")) : null}
            {selected ? tab("canvas", Frame, t("panel.canvas")) : null}
            {changes.length > 0 ? tab("changes", FileDiff, t("panel.changes")) : null}
            {terminal ? (
              <div className="workspaceRail-tab" data-selected={activeTab === "terminal"}>
                {tab("terminal", SquareTerminal, t("panel.terminal"))}
                {activeTab === "terminal" ? (
                  <IconButton
                    icon={X}
                    label={t("panel.closeTerminal")}
                    size={18}
                    className="workspaceRail-tabClose"
                    onClick={() => void api.closeTerminal()}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
          <IconButton
            icon={ChevronsRight}
            label={t("panel.hideSidePanel")}
            className="noDrag"
            onClick={() => void api.setAgentsPanelVisible(false)}
          />
        </div>
        <div className="workspaceRail-views">
          {runs.length > 0 ? (
            <div {...view("coworkers")}>
              <ul className="agentsRail-list">
                {runs.map((run) => (
                  <li key={run.toolCallId} className="agentsRail-item">
                    <button
                      type="button"
                      className={`agentsRow noDrag${
                        run.toolCallId === openTraceId ? " agentsRow-open" : ""
                      }`}
                      onClick={() => setOpenTraceId(run.toolCallId)}
                      title={t("panel.viewTrace", { title: run.title })}
                    >
                      <span className={`agentsRow-status agentsRow-${run.status}`}>
                        <AgentStatus status={run.status} />
                      </span>
                      <span className="agentsRow-text">
                        <span className="agentsRow-title">{run.title}</span>
                        <span className="agentsRow-detail">{agentSummary(run, t)}</span>
                      </span>
                      <Icon icon={ChevronRight} size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {selected ? (
            <div {...view("canvas")}>
              {views.length > 1 ? (
                <div className="canvas-tabs" role="tablist" aria-label={t("canvas.tabs")}>
                  {views.map((entry) => {
                    const title =
                      entry.artifact.kind === "mermaid" ? t("canvas.diagram") : entry.artifact.title
                    return (
                      <div
                        key={entry.key}
                        className={`canvas-tab${entry === selected ? " canvas-tab-selected" : ""}`}
                      >
                        <button
                          type="button"
                          role="tab"
                          className="canvas-tabOpen"
                          aria-selected={entry === selected}
                          onClick={() => setChosen({ key: entry.key, at: Date.now() })}
                        >
                          {title}
                        </button>
                        <button
                          type="button"
                          className="iconBtn canvas-tabClose"
                          aria-label={t("canvas.closeTab", { title })}
                          onClick={() =>
                            entry.runtime === undefined
                              ? onCloseDiagram()
                              : void api.closeArtifact(entry.runtime, entry.artifact.id)
                          }
                        >
                          <Icon icon={X} size={11} />
                        </button>
                      </div>
                    )
                  })}
                </div>
              ) : null}
              <CanvasPanel view={selected} />
            </div>
          ) : null}
          {changes.length > 0 ? (
            <div {...view("changes")}>
              <ChangesView changes={changes} />
            </div>
          ) : null}
          {terminal ? (
            <div {...view("terminal")}>
              <TerminalView key={theme} activated={terminalFocus} />
            </div>
          ) : null}
        </div>
      </aside>
      {openTraceId ? (
        <AgentTraceOverlay
          key={openTraceId}
          toolCallId={openTraceId}
          onClose={() => setOpenTraceId(undefined)}
        />
      ) : null}
    </>
  )
}

/** The session's edits by file, in the order the files were first touched, patches in sequence. */
function ChangesView({ changes }: { changes: Change[] }) {
  // The thumb appears on hover and flashes while scrolling, like the transcript.
  const scrollbar = useScrollbarFlash()
  const files = useMemo(() => {
    const byPath = new Map<string, { patches: Change[]; added: number; removed: number }>()
    for (const change of changes) {
      const file = byPath.get(change.activitySubject) ?? { patches: [], added: 0, removed: 0 }
      const lines = countDiffLines(change.diff)
      file.patches.push(change)
      file.added += lines.added
      file.removed += lines.removed
      byPath.set(change.activitySubject, file)
    }
    return [...byPath]
  }, [changes])
  return (
    <div
      className={`changesList${scrollbar.scrolling ? " scrolling" : ""}`}
      onScroll={scrollbar.onScroll}
    >
      {files.map(([path, file]) => {
        const [name, folder] = splitSubject("edit", path)
        return (
          <details key={path} className="changeFile" open>
            <summary className="changeFile-summary">
              <Icon icon={ChevronRight} size={12} className="changeFile-chevron" />
              <FileTypeIcon name={name} size="xs" />
              <span className="changeFile-path">
                <span className="changeFile-name">{name}</span>
                {folder ? <span className="changeFile-folder">{folder}</span> : null}
              </span>
              <span className="headerDiff">
                <span className="headerDiff-add">+{file.added}</span>
                <span className="headerDiff-remove">−{file.removed}</span>
              </span>
            </summary>
            {file.patches.map((change) => (
              <DiffView key={change.id} diff={change.diff} />
            ))}
          </details>
        )
      })}
    </div>
  )
}
