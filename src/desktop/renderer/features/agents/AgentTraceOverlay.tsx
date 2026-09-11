import { X } from "lucide-react"
import { useEffect, useState } from "react"
import type { TranscriptEntry } from "../../../../app/transcript.js"
import { IconButton } from "../../components/Button.js"
import { Icon } from "../../components/Icon.js"
import { useDesktop, useDesktopState } from "../../runtime.js"
import { reconcileTraceEntries } from "../../state.js"
import { TranscriptList } from "../conversation/TranscriptList.js"
import { AGENT_STATUS_ICONS, agentSummary } from "./agent-list.js"
import { createCoalescedLoader } from "./trace-loader.js"

/**
 * The full transcript of one delegated run, rendered with the same entry components as the main transcript.
 * While the run is live its entries refetch on each status event; the view closes when the run leaves the
 * session, mirroring the TUI's trace view.
 */
export function AgentTraceOverlay({ toolCallId, onClose }: { toolCallId: string; onClose: () => void }) {
  const { api } = useDesktop()
  const state = useDesktopState("subagents", "thinkingVisible")
  const run = state?.subagents.find((candidate) => candidate.toolCallId === toolCallId)
  const [entries, setEntries] = useState<TranscriptEntry[]>([])
  const running = run?.status === "running"

  // Status events stream live progress: each one can mean new trace entries. Refreshes coalesce behind the
  // in-flight request instead of discarding it, and changing the selected trace tears the loader down so a
  // late response can never land in the wrong view.
  useEffect(() => {
    const loader = createCoalescedLoader(
      () => api.getSubagentTrace(toolCallId),
      (fetched) => setEntries((previous) => reconcileTraceEntries(previous, fetched)),
    )
    loader.refresh()
    const unsubscribe = running
      ? api.subscribe((event) => {
          if (event.type === "status") loader.refresh()
        })
      : undefined
    return () => {
      unsubscribe?.()
      loader.dispose()
    }
  }, [api, toolCallId, running])

  // The run left the session (a session switch or reset): nothing to show anymore.
  useEffect(() => {
    if (state && !run) onClose()
  }, [state, run, onClose])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.stopPropagation()
      onClose()
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [onClose])

  return (
    <>
      <button type="button" className="overlayBackdrop" aria-label="Close trace" onClick={onClose} />
      <div className="agentTrace noDrag" role="dialog" aria-modal="true" aria-label={`Trace: ${run?.title ?? "run"}`}>
        <div className="agentTrace-title">
          {run ? (
            <span className={`agentsRow-status agentsRow-${run.status}`}>
              <Icon icon={AGENT_STATUS_ICONS[run.status]} size={12} />
            </span>
          ) : null}
          <span className="agentTrace-name">{run?.title ?? "Coworker"}</span>
          {run ? <span className="agentTrace-summary">{agentSummary(run)}</span> : null}
          <span className="agentTrace-titleSpace" />
          <IconButton icon={X} label="Close trace" size={22} onClick={onClose} />
        </div>
        {entries.length > 0 ? (
          <TranscriptList key={toolCallId} entries={entries} thinkingVisible={state?.thinkingVisible ?? false} />
        ) : null}
      </div>
    </>
  )
}
