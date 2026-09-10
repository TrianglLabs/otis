import { ChevronRight, ChevronsRight } from "lucide-react"
import { useEffect, useRef, useState } from "react"
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
  const visible = state?.agentsPanelVisible ?? true

  // Runs appearing from an empty rail means coworkers started doing stuff — open the rail on its own. The
  // first effect after a mount only records state: opening Settings unmounts this panel, and remounting must
  // not treat existing runs as new. Hiding it manually is respected until the runs list empties and fills again.
  const hadRuns = useRef<boolean | undefined>(undefined)
  useEffect(() => {
    const hasRuns = runs.length > 0
    const had = hadRuns.current
    hadRuns.current = hasRuns
    if (had !== false || !hasRuns || visible) return
    void api.setAgentsPanelVisible(true)
  }, [runs.length, visible, api])

  if (runs.length === 0) return null
  return (
    <>
      {visible ? (
        <aside className="agentsRail" aria-label="Coworkers">
          <div className="agentsRail-section">
            <span>Coworkers</span>
            <IconButton
              icon={ChevronsRight}
              label="Hide coworkers panel"
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
