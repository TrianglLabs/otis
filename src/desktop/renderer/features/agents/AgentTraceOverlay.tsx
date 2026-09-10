import { X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type { TranscriptEntry } from "../../../../app/transcript.js"
import { IconButton } from "../../components/Button.js"
import { Icon } from "../../components/Icon.js"
import { useDesktop, useDesktopState } from "../../runtime.js"
import { useScrollbarFlash } from "../../useScrollbarFlash.js"
import { EntryView } from "../conversation/entries.js"
import { visibleEntries } from "../conversation/visible-entries.js"
import { AGENT_STATUS_ICONS, agentSummary } from "./agent-list.js"
import { createCoalescedLoader } from "./trace-loader.js"

/**
 * The full transcript of one delegated run, rendered with the same entry components as the main transcript.
 * While the run is live its entries refetch on each status event; the view closes when the run leaves the
 * session, mirroring the TUI's trace view.
 */
export function AgentTraceOverlay({ toolCallId, onClose }: { toolCallId: string; onClose: () => void }) {
  const { api } = useDesktop()
  const state = useDesktopState()
  const run = state?.subagents.find((candidate) => candidate.toolCallId === toolCallId)
  const [entries, setEntries] = useState<TranscriptEntry[]>([])
  const scrollbar = useScrollbarFlash()
  const listRef = useRef<HTMLDivElement>(null)
  const scrolledToEnd = useRef(false)

  // Status events stream live progress: each one can mean new trace entries. Refreshes coalesce behind the
  // in-flight request instead of discarding it, and changing the selected trace tears the loader down so a
  // late response can never land in the wrong view.
  useEffect(() => {
    const loader = createCoalescedLoader(
      () => api.getSubagentTrace(toolCallId),
      (fetched) => setEntries(fetched),
    )
    loader.refresh()
    const unsubscribe = api.subscribe(loader.refresh)
    return () => {
      unsubscribe()
      loader.dispose()
    }
  }, [api, toolCallId])

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

  // Open at the end of the run, like the TUI trace view; later updates keep the user's scroll position.
  useEffect(() => {
    if (scrolledToEnd.current || entries.length === 0) return
    scrolledToEnd.current = true
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [entries])

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
        <div
          className={`agentTrace-list${scrollbar.scrolling ? " scrolling" : ""}`}
          onScroll={scrollbar.onScroll}
          ref={listRef}
        >
          {visibleEntries(entries, state?.thinkingVisible ?? false).map((entry) => (
            <EntryView key={entry.id} entry={entry} active={false} thinkingVisible={state?.thinkingVisible ?? false} />
          ))}
        </div>
      </div>
    </>
  )
}
