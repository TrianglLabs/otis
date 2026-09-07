import { ChevronRight, PanelRightClose } from "lucide-react"
import { useState } from "react"
import { IconButton } from "../../components/Button.js"
import { Icon } from "../../components/Icon.js"
import { useDesktop, useDesktopState } from "../../runtime.js"
import { AgentTraceOverlay } from "./AgentTraceOverlay.js"
import { AGENT_STATUS_ICONS, agentSummary } from "./agent-list.js"

/**
 * The session's delegated runs in a right-hand rail, mirroring the TUI's subagent panel. The rail appears when
 * the session has runs and the persisted visibility preference is on; the workspace header offers a show button
 * while it is hidden. Selecting a run opens its trace.
 */
export function AgentsPanel() {
  const { api } = useDesktop()
  const state = useDesktopState()
  const [openTraceId, setOpenTraceId] = useState<string>()
  const [traceSessionId, setTraceSessionId] = useState(state?.session?.id)
  // A session switch retires every run: drop the open trace during render so it cannot reopen for the
  // previous session when its runs list is (briefly) empty.
  if (traceSessionId !== state?.session?.id) {
    setTraceSessionId(state?.session?.id)
    setOpenTraceId(undefined)
  }
  const runs = state?.subagents ?? []
  if (runs.length === 0) return null
  const visible = state?.agentsPanelVisible ?? true
  return (
    <>
      {visible ? (
        <aside className="agentsRail" aria-label="Delegated runs">
          <div className="agentsRail-topspace" />
          <div className="agentsRail-section">
            <span>Subagents</span>
            <IconButton
              icon={PanelRightClose}
              label="Hide subagents panel"
              size={22}
              className="noDrag"
              onClick={() => void api.setAgentsPanelVisible(false)}
            />
          </div>
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
        </aside>
      ) : null}
      {openTraceId ? <AgentTraceOverlay toolCallId={openTraceId} onClose={() => setOpenTraceId(undefined)} /> : null}
    </>
  )
}
