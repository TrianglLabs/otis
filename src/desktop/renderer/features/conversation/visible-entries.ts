import type { TranscriptEntry } from "../../../../app/transcript.js"

/**
 * Mirrors the reasoning filter in src/cli/ui/transcript-view.ts (the CLI module cannot be imported into the
 * renderer bundle): thinking traces leave the transcript entirely when the preference hides them.
 */
export function visibleEntries(entries: TranscriptEntry[], thinkingVisible: boolean): TranscriptEntry[] {
  if (thinkingVisible) return entries
  return entries.filter((entry) => entry.kind !== "reasoning")
}
