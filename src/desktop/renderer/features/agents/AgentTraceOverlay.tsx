import { Check, CircleSlash, X } from "lucide-react"
import { useEffect, useState } from "react"
import type { TranscriptEntry } from "../../../../app/transcript.js"
import type { SubagentSummary } from "../../../contracts.js"
import { IconButton } from "../../components/Button.js"
import { Icon } from "../../components/Icon.js"
import { MatrixLoader } from "../../components/MatrixLoader.js"
import { formatElapsed } from "../../format.js"
import { englishT, useI18n } from "../../i18n/index.js"
import type { Translate } from "../../i18n/messages/en.js"
import { useDesktop, useDesktopState } from "../../runtime.js"
import { reconcileTraceEntries } from "../../state.js"
import { TranscriptList } from "../conversation/TranscriptList.js"

/** How often a live run's entries are fetched while the overlay is open. */
const TRACE_POLL_MS = 250

/**
 * The full transcript of one delegated run, rendered with the same entry components as the main
 * transcript. While the run is live its entries are polled; the view closes when the run leaves
 * the session, mirroring the TUI's trace view.
 */
export function AgentTraceOverlay({
  toolCallId,
  onClose,
}: {
  toolCallId: string
  onClose: () => void
}) {
  const { api } = useDesktop()
  const { t } = useI18n()
  const state = useDesktopState("subagents", "thinkingVisible")
  const run = state?.subagents.find((candidate) => candidate.toolCallId === toolCallId)
  const [entries, setEntries] = useState<TranscriptEntry[]>([])
  const running = run?.status === "running"

  // A refresh arriving while a load runs marks at most one follow-up load, which starts when the
  // current one settles. Changing the selected trace (or a session change) disposes the loader,
  // so a late response can never land in the wrong view.
  useEffect(() => {
    let inFlight = false
    let queued = false
    let disposed = false
    const refresh = () => {
      if (disposed) return
      if (inFlight) {
        queued = true
        return
      }
      inFlight = true
      void api
        .getSubagentTrace(toolCallId)
        .then((fetched) => {
          if (!disposed) setEntries((previous) => reconcileTraceEntries(previous, fetched))
        })
        .catch(() => {})
        .finally(() => {
          inFlight = false
          if (!queued || disposed) return
          queued = false
          refresh()
        })
    }
    refresh()
    const timer = running ? setInterval(refresh, TRACE_POLL_MS) : undefined
    return () => {
      clearInterval(timer)
      disposed = true
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
      <button
        type="button"
        className="overlayBackdrop"
        aria-label={t("trace.close")}
        onClick={onClose}
      />
      <div
        className="agentTrace noDrag"
        role="dialog"
        aria-modal="true"
        aria-label={t("trace.dialog", { title: run?.title ?? t("trace.run") })}
      >
        <div className="agentTrace-title">
          {run ? (
            <span className={`agentsRow-status agentsRow-${run.status}`}>
              <AgentStatus status={run.status} />
            </span>
          ) : null}
          <span className="agentTrace-name">{run?.title ?? t("trace.coworker")}</span>
          {run ? <span className="agentTrace-summary">{agentSummary(run, t)}</span> : null}
          <span className="agentTrace-titleSpace" />
          <IconButton icon={X} label={t("trace.close")} size={22} onClick={onClose} />
        </div>
        {entries.length > 0 ? (
          <TranscriptList
            key={toolCallId}
            entries={entries}
            thinkingVisible={state?.thinkingVisible ?? false}
          />
        ) : null}
      </div>
    </>
  )
}

/** A run's status for its row and the trace title bar: the loader while it runs, else an icon. */
export function AgentStatus({ status }: { status: SubagentSummary["status"] }) {
  return status === "running" ? <MatrixLoader /> : <Icon icon={STOPPED_ICONS[status]} size={12} />
}

const STOPPED_ICONS: Record<Exclude<SubagentSummary["status"], "running">, typeof Check> = {
  complete: Check,
  failed: X,
  interrupted: CircleSlash,
}

/**
 * Progress line for a delegated run, mirroring subagentSummary in the TUI's subagent panel
 * (src/cli/ui/subagent-panel.ts) exactly: tool count, then "running" or the wall-clock time, then a
 * terminal lifecycle word for failed or interrupted runs.
 */
export function agentSummary(
  run: Pick<SubagentSummary, "status" | "tools" | "durationMs">,
  t: Translate = englishT,
): string {
  const parts = [t("panel.toolCount", { count: run.tools })]
  if (run.status === "running") parts.push(t("panel.running"))
  else if (run.durationMs !== undefined) parts.push(formatElapsed(run.durationMs))
  if (run.status === "failed") parts.push(t("panel.failed"))
  if (run.status === "interrupted") parts.push(t("panel.interrupted"))
  return parts.join(" · ")
}
