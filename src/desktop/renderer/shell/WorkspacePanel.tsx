import { ChevronRight, ChevronsRight } from "lucide-react"
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import type { SubagentSummary, ThemeName } from "../../contracts.js"
import { IconButton } from "../components/Button.js"
import { Icon } from "../components/Icon.js"
import { AgentTraceOverlay } from "../features/agents/AgentTraceOverlay.js"
import { AGENT_STATUS_ICONS, agentSummary } from "../features/agents/agent-list.js"
import { CanvasPanel } from "../features/canvas/CanvasPanel.js"
import type { CanvasArtifact } from "../features/canvas/canvas-context.js"
import { useI18n } from "../i18n/index.js"
import { useDesktop, useDesktopSelector } from "../runtime.js"

type PanelTab = "coworkers" | "canvas"
const EMPTY_RUNS: SubagentSummary[] = []
const PANEL_MIN_WIDTH = 240
const PANEL_MAX_WIDTH = 720
const MAIN_MIN_WIDTH = 480
const PANEL_KEYBOARD_STEP = 16

/** The session's secondary workspace: delegated runs and the Mermaid block explicitly opened in Canvas. */
export function WorkspacePanel({ artifact }: { artifact: CanvasArtifact | undefined }) {
  const [railWidth, setRailWidth] = useState<number>()
  const state = useDesktopSelector((snapshot) => ({
    sessionId: snapshot?.session?.id,
    runs: snapshot?.subagents ?? EMPTY_RUNS,
    visible: snapshot?.agentsPanelVisible ?? true,
    theme: snapshot?.theme ?? "default",
  }))
  return (
    <SessionWorkspacePanel
      key={state.sessionId}
      {...state}
      artifact={artifact}
      railWidth={railWidth}
      onRailWidthChange={setRailWidth}
    />
  )
}

function SessionWorkspacePanel({
  runs,
  artifact,
  visible,
  theme,
  railWidth,
  onRailWidthChange,
}: {
  runs: SubagentSummary[]
  artifact: CanvasArtifact | undefined
  visible: boolean
  theme: ThemeName
  railWidth: number | undefined
  onRailWidthChange: (width: number | undefined) => void
}) {
  const { api } = useDesktop()
  const { t } = useI18n()
  const [activeTab, setActiveTab] = useState<PanelTab>(artifact ? "canvas" : "coworkers")
  const [openTraceId, setOpenTraceId] = useState<string>()
  const [resizing, setResizing] = useState(false)
  const [contentMinWidth, setContentMinWidth] = useState(PANEL_MIN_WIDTH)
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  const panelRef = useRef<HTMLElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)
  const tabsRef = useRef<HTMLDivElement>(null)
  const stopResizeRef = useRef<() => void>(() => {})
  const hasContent = runs.length > 0 || artifact !== undefined

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
      const border = panelRef.current ? Number.parseFloat(getComputedStyle(panelRef.current).borderLeftWidth) || 0 : 0
      const tabsWidth = tabs.getBoundingClientRect().width || tabs.scrollWidth
      const collapseWidth = collapse.getBoundingClientRect().width || collapse.offsetWidth
      setContentMinWidth(
        Math.max(PANEL_MIN_WIDTH, Math.ceil(horizontalPadding + gap + border + tabsWidth + collapseWidth)),
      )
    }
    measure()
    // Intrinsic tab widths also change when fonts finish loading or the display scale changes.
    const observer = new ResizeObserver(measure)
    observer.observe(tabs)
    observer.observe(collapse)
    return () => observer.disconnect()
  }, [hasContent, activeTab, t, theme, visible])

  // The first coworker reopens a hidden rail. Additional coworkers do not interrupt the active tab, and
  // remounting Settings with existing work does not override the user's visibility choice.
  const hadRuns = useRef<boolean | undefined>(undefined)
  useEffect(() => {
    const hasRuns = runs.length > 0
    const previous = hadRuns.current
    hadRuns.current = hasRuns
    if (previous === false && hasRuns && !visible) void api.setAgentsPanelVisible(true)
  }, [runs.length, visible, api])

  const previousArtifactId = useRef<number | null>(artifact?.id ?? null)
  useEffect(() => {
    const previous = previousArtifactId.current
    previousArtifactId.current = artifact?.id ?? null
    if (!artifact || artifact.id === previous) return
    setActiveTab("canvas")
    if (!visible) void api.setAgentsPanelVisible(true)
  }, [artifact, visible, api])

  const maxWidth = Math.max(contentMinWidth, Math.min(PANEL_MAX_WIDTH, viewportWidth - MAIN_MIN_WIDTH))
  const defaultWidth = activeTab === "coworkers" ? 240 : Math.min(560, Math.max(280, Math.round(viewportWidth * 0.38)))
  const clampWidth = (width: number) => Math.min(maxWidth, Math.max(contentMinWidth, Math.round(width)))
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
  return (
    <>
      <aside
        ref={panelRef}
        className={`workspaceRail${activeTab === "canvas" ? " workspaceRail-canvas" : ""}${visible ? "" : " workspaceRail-hidden"}${resizing ? " workspaceRail-resizing" : ""}`}
        aria-label={t("panel.workspacePanel")}
        aria-hidden={!visible}
        inert={visible ? undefined : true}
        style={
          {
            "--workspace-rail-width": `${effectiveWidth}px`,
          } as CSSProperties
        }
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
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "coworkers"}
              onClick={() => setActiveTab("coworkers")}
            >
              {t("panel.coworkers")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "canvas"}
              onClick={() => setActiveTab("canvas")}
            >
              {t("panel.canvas")}
            </button>
          </div>
          <IconButton
            icon={ChevronsRight}
            label={t("panel.hideSidePanel")}
            className="noDrag"
            onClick={() => void api.setAgentsPanelVisible(false)}
          />
        </div>
        <div className="workspaceRail-views">
          <div
            className={`workspaceRail-view workspaceRail-view-coworkers${activeTab === "coworkers" ? " workspaceRail-view-active" : ""}`}
            aria-hidden={activeTab !== "coworkers"}
          >
            {runs.length > 0 ? (
              <ul className="agentsRail-list">
                {runs.map((run) => (
                  <li key={run.toolCallId} className="agentsRail-item">
                    <button
                      type="button"
                      className={`agentsRow noDrag${run.toolCallId === openTraceId ? " agentsRow-open" : ""}`}
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
          <div
            className={`workspaceRail-view workspaceRail-view-canvas${activeTab === "canvas" ? " workspaceRail-view-active" : ""}`}
            aria-hidden={activeTab !== "canvas"}
          >
            <CanvasPanel artifact={artifact} theme={theme} />
          </div>
        </div>
      </aside>
      {openTraceId ? (
        <AgentTraceOverlay key={openTraceId} toolCallId={openTraceId} onClose={() => setOpenTraceId(undefined)} />
      ) : null}
    </>
  )
}
