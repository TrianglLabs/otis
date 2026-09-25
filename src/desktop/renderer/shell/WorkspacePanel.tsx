import { ChevronRight, ChevronsRight, X } from "lucide-react"
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import type { SubagentSummary, ThemeName } from "../../contracts.js"
import { IconButton } from "../components/Button.js"
import { Icon } from "../components/Icon.js"
import {
  AGENT_STATUS_ICONS,
  AgentTraceOverlay,
  agentSummary,
} from "../features/agents/AgentTraceOverlay.js"
import { CanvasPanel } from "../features/canvas/CanvasPanel.js"
import type { CanvasView } from "../features/canvas/canvas-context.js"
import { useI18n } from "../i18n/index.js"
import { useDesktop, useDesktopSelector } from "../runtime.js"

type PanelTab = "coworkers" | "canvas"
const PANEL_TABS: readonly PanelTab[] = ["coworkers", "canvas"]
const EMPTY_RUNS: SubagentSummary[] = []
const PANEL_MIN_WIDTH = 240
const PANEL_MAX_WIDTH = 720
const MAIN_MIN_WIDTH = 480
const PANEL_KEYBOARD_STEP = 16

/**
 * The session's secondary workspace: delegated runs and the Mermaid block explicitly opened in
 * Canvas.
 */
export function WorkspacePanel({
  views,
  onCloseDiagram,
}: {
  views: CanvasView[]
  onCloseDiagram: () => void
}) {
  // Drags update the local width immediately; the saved width seeds it and survives relaunches.
  const [railWidth, setRailWidth] = useState<number>()
  const state = useDesktopSelector((snapshot) => ({
    runs: snapshot?.subagents ?? EMPTY_RUNS,
    visible: snapshot?.agentsPanelVisible ?? true,
    theme: snapshot?.theme ?? "default",
    savedWidth: snapshot?.workspacePanelWidth,
  }))
  const { savedWidth, ...panel } = state
  return (
    <SessionWorkspacePanel
      {...panel}
      views={views}
      onCloseDiagram={onCloseDiagram}
      railWidth={railWidth ?? savedWidth}
      onRailWidthChange={setRailWidth}
    />
  )
}

function SessionWorkspacePanel({
  runs,
  views,
  onCloseDiagram,
  visible,
  theme,
  railWidth,
  onRailWidthChange,
}: {
  runs: SubagentSummary[]
  views: CanvasView[]
  onCloseDiagram: () => void
  visible: boolean
  theme: ThemeName
  railWidth: number | undefined
  onRailWidthChange: (width: number | undefined) => void
}) {
  const { api } = useDesktop()
  const { t } = useI18n()
  const [activeTab, setActiveTab] = useState<PanelTab>(views.length > 0 ? "canvas" : "coworkers")
  // The tab that last took the view shows, unless the user picked another one since.
  const [chosen, setChosen] = useState<{ key: string; at: number }>()
  const latest = views.reduce<CanvasView | undefined>(
    (best, view) => (!best || view.activated > best.activated ? view : best),
    undefined,
  )
  const selected =
    (chosen && chosen.at >= (latest?.activated ?? 0) && views.find((v) => v.key === chosen.key)) ||
    latest
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
  const hasContent = runs.length > 0 || views.length > 0

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
    setActiveTab("coworkers")
    if (!visible) void api.setAgentsPanelVisible(true)
  }, [runs.length, visible, api])

  const latestActivated = latest?.activated
  const seenActivated = useRef(latestActivated)
  useEffect(() => {
    const previous = seenActivated.current
    seenActivated.current = latestActivated
    if (latestActivated === undefined || latestActivated === previous) return
    setActiveTab("canvas")
    if (!visible) void api.setAgentsPanelVisible(true)
  }, [latestActivated, visible, api])

  const maxWidth = Math.max(
    contentMinWidth,
    Math.min(PANEL_MAX_WIDTH, viewportWidth - MAIN_MIN_WIDTH),
  )
  const defaultWidth =
    activeTab === "coworkers" ? 240 : Math.min(560, Math.max(280, Math.round(viewportWidth * 0.38)))
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
    const index = PANEL_TABS.indexOf(activeTab)
    let next: number
    if (event.key === "ArrowRight") next = (index + 1) % PANEL_TABS.length
    else if (event.key === "ArrowLeft") next = (index + PANEL_TABS.length - 1) % PANEL_TABS.length
    else if (event.key === "Home") next = 0
    else if (event.key === "End") next = PANEL_TABS.length - 1
    else return
    event.preventDefault()
    setActiveTab(PANEL_TABS[next])
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
  const tab = (name: PanelTab, label: string) => (
    <button
      type="button"
      role="tab"
      id={`${panelId}-tab-${name}`}
      aria-selected={activeTab === name}
      aria-controls={`${panelId}-view-${name}`}
      tabIndex={activeTab === name ? 0 : -1}
      onClick={() => setActiveTab(name)}
    >
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
            {tab("coworkers", t("panel.coworkers"))}
            {tab("canvas", t("panel.canvas"))}
          </div>
          <IconButton
            icon={ChevronsRight}
            label={t("panel.hideSidePanel")}
            className="noDrag"
            onClick={() => void api.setAgentsPanelVisible(false)}
          />
        </div>
        <div className="workspaceRail-views">
          <div {...view("coworkers")}>
            {runs.length > 0 ? (
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
                        <Icon icon={AGENT_STATUS_ICONS[run.status]} size={12} />
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
            ) : (
              <div className="workspaceRail-empty">{t("panel.noCoworkers")}</div>
            )}
          </div>
          <div {...view("canvas")}>
            {views.length > 1 ? (
              <nav className="canvas-tabs" aria-label={t("canvas.tabs")}>
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
                        className="canvas-tabOpen"
                        aria-pressed={entry === selected}
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
              </nav>
            ) : null}
            <CanvasPanel view={selected} theme={theme} />
          </div>
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
