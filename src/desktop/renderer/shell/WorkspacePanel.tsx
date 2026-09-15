import { ChevronRight, ChevronsRight } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type { SubagentSummary, ThemeName } from "../../contracts.js"
import { IconButton } from "../components/Button.js"
import { Icon } from "../components/Icon.js"
import { AgentTraceOverlay } from "../features/agents/AgentTraceOverlay.js"
import { AGENT_STATUS_ICONS, agentSummary } from "../features/agents/agent-list.js"
import { CanvasPanel } from "../features/canvas/CanvasPanel.js"
import type { CanvasArtifact } from "../features/canvas/canvas-context.js"
import { useDesktop, useDesktopSelector } from "../runtime.js"

type PanelTab = "coworkers" | "canvas"
const EMPTY_RUNS: SubagentSummary[] = []

/** The session's secondary workspace: delegated runs and the Mermaid block explicitly opened in Canvas. */
export function WorkspacePanel({ artifact }: { artifact: CanvasArtifact | undefined }) {
  const state = useDesktopSelector((snapshot) => ({
    sessionId: snapshot?.session?.id,
    runs: snapshot?.subagents ?? EMPTY_RUNS,
    visible: snapshot?.agentsPanelVisible ?? true,
    theme: snapshot?.theme ?? "default",
  }))
  return <SessionWorkspacePanel key={state.sessionId} {...state} artifact={artifact} />
}

function SessionWorkspacePanel({
  runs,
  artifact,
  visible,
  theme,
}: {
  runs: SubagentSummary[]
  artifact: CanvasArtifact | undefined
  visible: boolean
  theme: ThemeName
}) {
  const { api } = useDesktop()
  const [activeTab, setActiveTab] = useState<PanelTab>(artifact ? "canvas" : "coworkers")
  const [openTraceId, setOpenTraceId] = useState<string>()

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

  if (runs.length === 0 && !artifact) return null
  return (
    <>
      <aside
        className={`workspaceRail${activeTab === "canvas" ? " workspaceRail-canvas" : ""}${visible ? "" : " workspaceRail-hidden"}`}
        aria-label="Workspace panel"
        aria-hidden={!visible}
        inert={visible ? undefined : true}
      >
        <div className="workspaceRail-header">
          <div className="workspaceRail-tabs noDrag" role="tablist" aria-label="Workspace views">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "coworkers"}
              onClick={() => setActiveTab("coworkers")}
            >
              Coworkers
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "canvas"}
              onClick={() => setActiveTab("canvas")}
            >
              Canvas
            </button>
          </div>
          <IconButton
            icon={ChevronsRight}
            label="Hide side panel"
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
                      title={`${run.title} — view trace`}
                    >
                      <span className={`agentsRow-status agentsRow-${run.status}`}>
                        <Icon icon={AGENT_STATUS_ICONS[run.status]} size={12} />
                      </span>
                      <span className="agentsRow-text">
                        <span className="agentsRow-title">{run.title}</span>
                        <span className="agentsRow-detail">{agentSummary(run)}</span>
                      </span>
                      <Icon icon={ChevronRight} size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="workspaceRail-empty">No coworkers in this session.</div>
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
