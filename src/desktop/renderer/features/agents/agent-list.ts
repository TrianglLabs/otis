import { Check, CircleSlash, Loader2, X } from "lucide-react"
import type { SubagentSummary } from "../../../contracts.js"
import type { Translate } from "../../i18n/messages/en.js"
import { englishT } from "../../i18n/translate.js"

/** Status glyphs for run rows and the trace view's title bar. */
export const AGENT_STATUS_ICONS: Record<SubagentSummary["status"], typeof Check> = {
  running: Loader2,
  complete: Check,
  failed: X,
  interrupted: CircleSlash,
}

/** Mirrors formatElapsed in src/cli/ui/format.ts; duplicated to keep the CLI module out of the renderer bundle. */
function formatElapsed(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`
  const seconds = durationMs / 1_000
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`
}

/**
 * Progress line for a delegated run, mirroring subagentSummary in the TUI's subagent panel
 * (src/cli/ui/subagent-panel.ts) exactly: tool count, then "running" or the wall-clock time, then a terminal
 * lifecycle word for failed or interrupted runs.
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
