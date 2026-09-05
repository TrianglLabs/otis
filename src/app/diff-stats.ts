import type { TranscriptEntry } from "./transcript.js"

export type DiffStats = { added: number; removed: number }

export function countDiffLines(diff: string): DiffStats {
  let added = 0
  let removed = 0

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue
    if (line.startsWith("+")) added += 1
    else if (line.startsWith("-")) removed += 1
  }

  return { added, removed }
}

export function countTranscriptDiffLines(entries: readonly TranscriptEntry[]): DiffStats {
  const total: DiffStats = { added: 0, removed: 0 }

  for (const entry of entries) {
    if (!entry.diff) continue
    const counts = countDiffLines(entry.diff)
    total.added += counts.added
    total.removed += counts.removed
  }

  return total
}
