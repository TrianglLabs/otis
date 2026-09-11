import type { TranscriptEntry } from "../../../../app/transcript.js"

/**
 * A condensed run of consecutive tool activity. The run id is its first entry's id, which stays stable as the
 * run grows, so expansion state and list keys survive new activity.
 */
export type ToolRun = { kind: "toolRun"; id: number; entries: TranscriptEntry[] }
export type TranscriptItem = TranscriptEntry | ToolRun

/**
 * Consecutive tool cards collapse into one run row: a burst of reads, searches, and commands is noise once it
 * scrolls by. A tool entry carrying a diff stays standalone and breaks the run — edited code is content, not a
 * summary. Single tools render as they always have.
 */
export function groupToolRuns(entries: TranscriptEntry[]): TranscriptItem[] {
  const items: TranscriptItem[] = []
  let run: TranscriptEntry[] = []
  const flush = () => {
    if (run.length >= 2 && run[0]) items.push({ kind: "toolRun", id: run[0].id, entries: run })
    else items.push(...run)
    run = []
  }
  for (const entry of entries) {
    if (entry.kind === "tool" && !entry.diff) {
      run.push(entry)
    } else {
      flush()
      items.push(entry)
    }
  }
  flush()
  return items
}

/**
 * The virtualized list's data. An expanded run's entries follow its row as ordinary list items, so windowing
 * keeps bounding the DOM no matter how long the run is — rendering them inside the run's row would bypass
 * virtualization entirely. `expandedEntries` marks the flattened entries so the list can indent them.
 */
export function flattenExpandedRuns(
  grouped: TranscriptItem[],
  expandedRuns: ReadonlySet<number>,
): { items: TranscriptItem[]; expandedEntries: ReadonlySet<number> } {
  const items: TranscriptItem[] = []
  const expandedEntries = new Set<number>()
  for (const item of grouped) {
    items.push(item)
    if (item.kind !== "toolRun" || !expandedRuns.has(item.id)) continue
    for (const entry of item.entries) {
      items.push(entry)
      expandedEntries.add(entry.id)
    }
  }
  return { items, expandedEntries }
}
