import type { TranscriptEntry } from "../../../../app/transcript.js"

/**
 * Empty assistant deltas have no visible content: keeping their wrappers would add blank space and split
 * consecutive tool runs. Thinking traces also leave the transcript when hidden, except for the live status.
 */
export function visibleEntries(entries: TranscriptEntry[], thinkingVisible: boolean): TranscriptEntry[] {
  const visible = entries.filter((entry) => {
    if (entry.kind === "reasoning") return thinkingVisible || entry.streaming === true
    if (entry.kind === "message" && entry.speaker === "Otis") return !!entry.text.trim() || !!entry.artifacts?.length
    return true
  })
  return visible.length === entries.length ? entries : visible
}
