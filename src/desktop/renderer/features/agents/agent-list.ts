import { Check, CircleSlash, Loader2, X } from "lucide-react"
import type { SubagentSummary } from "../../../contracts.js"

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
export function agentSummary(run: Pick<SubagentSummary, "status" | "tools" | "durationMs">): string {
  const parts = [`${run.tools} ${run.tools === 1 ? "tool" : "tools"}`]
  if (run.status === "running") parts.push("running")
  else if (run.durationMs !== undefined) parts.push(formatElapsed(run.durationMs))
  if (run.status === "failed") parts.push("failed")
  if (run.status === "interrupted") parts.push("interrupted")
  return parts.join(" · ")
}
