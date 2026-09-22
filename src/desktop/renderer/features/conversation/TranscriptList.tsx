import { ArrowDown } from "lucide-react"
import {
  type ComponentProps,
  forwardRef,
  memo,
  type ReactNode,
  useCallback,
  useMemo,
  useState,
} from "react"
import { Virtuoso } from "react-virtuoso"
import type { TranscriptEntry } from "../../../../app/transcript.js"
import { Icon } from "../../components/Icon.js"
import { EntryView } from "./entries.js"
import { ToolRunCard } from "./ToolCard.js"
import { useTranscriptScroll } from "./useTranscriptScroll.js"

/**
 * A condensed run of consecutive tool activity. The run id is its first entry's id, which stays
 * stable as the run grows, so expansion state and list keys survive new activity.
 */
export type ToolRun = { kind: "toolRun"; id: number; entries: TranscriptEntry[] }
type TranscriptItem = TranscriptEntry | ToolRun

/**
 * Empty assistant deltas have no visible content: keeping their wrappers would add blank space and
 * split consecutive tool runs. Thinking traces also leave the transcript when hidden, except for
 * the live status.
 */
function visibleEntries(entries: TranscriptEntry[], thinkingVisible: boolean): TranscriptEntry[] {
  const visible = entries.filter((entry) => {
    if (entry.kind === "reasoning") return thinkingVisible || entry.streaming === true
    if (entry.kind === "message" && entry.speaker === "Otis")
      return !!entry.text.trim() || !!entry.artifacts?.length
    return true
  })
  return visible.length === entries.length ? entries : visible
}

/**
 * A tool entry carrying a diff or a ready artifact is content, not a summary; the rest is
 * condensable activity.
 */
function isActivity(entry: TranscriptEntry): boolean {
  if (entry.kind !== "tool") return false
  const displaysArtifact =
    entry.artifact && entry.artifactDisplay !== "pending" && entry.artifactDisplay !== "superseded"
  return !entry.diff && !displaysArtifact
}

/**
 * Consecutive tool cards collapse into one run row: a burst of reads, searches, and commands is
 * noise once it scrolls by. A tool entry carrying a diff stays standalone and breaks the run —
 * edited code is content, not a summary. Single tools render as they always have.
 */
function groupToolRuns(entries: TranscriptEntry[]): TranscriptItem[] {
  const items: TranscriptItem[] = []
  let run: TranscriptEntry[] = []
  const flush = () => {
    if (run.length >= 2) items.push({ kind: "toolRun", id: run[0].id, entries: run })
    else items.push(...run)
    run = []
  }
  for (const entry of entries) {
    if (isActivity(entry)) {
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
 * The virtualized list's data. An expanded run's entries follow its row as ordinary list items, so
 * windowing keeps bounding the DOM no matter how long the run is — rendering them inside the run's
 * row would bypass virtualization entirely. `expandedEntries` marks the flattened entries so the
 * list can indent them.
 */
function flattenExpandedRuns(
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

type ListContext = { footer?: ReactNode }

// Keep component types outside the render path: a new List/Footer type remounts the visible
// conversation.
const List = forwardRef<HTMLDivElement, ComponentProps<"div"> & { context?: ListContext }>(
  function List({ context: _context, ...props }, ref) {
    return <div {...props} className="transcript" ref={ref} />
  },
)
function Footer({ context }: { context?: ListContext }) {
  return <div className="transcriptFooter">{context?.footer}</div>
}
function Header() {
  return <div className="transcriptHeader" />
}
const components = { List, Header, Footer }
// A run's id is its first entry's id; when the run is expanded, that entry follows the run's row as
// its own item — so run rows key with a prefix to never collide with entry rows.
const itemKey = (_index: number, item: TranscriptItem) =>
  item.kind === "toolRun" ? `run-${item.id}` : item.id
const initialPosition = { index: "LAST", align: "end" } as const

/**
 * Activity rows (runs, reasoning, debug lines, condensable tools) pack tighter against each other.
 */
const isActivityRow = (item: TranscriptItem | undefined) =>
  !!item && item.kind !== "message" && (item.kind !== "tool" || isActivity(item))

/**
 * Only the visible slice mounts. Virtuoso measures rows; the scroll hook owns following the live
 * tail.
 */
export const TranscriptList = memo(function TranscriptList({
  entries,
  thinkingVisible,
  busy = false,
  footer,
}: {
  entries: TranscriptEntry[]
  thinkingVisible: boolean
  busy?: boolean
  footer?: ReactNode
}) {
  const visible = useMemo(
    () => visibleEntries(entries, thinkingVisible),
    [entries, thinkingVisible],
  )
  const scroll = useTranscriptScroll()
  // Disclosure state belongs to the transcript, so scrolling a row out of the viewport doesn't
  // collapse it.
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set())
  const setEntryExpanded = useCallback((id: number, open: boolean) => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (open) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])
  // Expanded runs flatten into ordinary rows, so a long run stays windowed like the rest of the
  // transcript.
  const { items, expandedEntries } = useMemo(
    () => flattenExpandedRuns(groupToolRuns(visible), expanded),
    [visible, expanded],
  )
  const context = useMemo(() => ({ footer }), [footer])
  const renderEntry = useCallback(
    (index: number, item: TranscriptItem) => {
      // Neighbor-aware spacing belongs inside each measured row, including flattened run entries.
      const activity = isActivityRow(item) && isActivityRow(items[index + 1])
      const className = `transcriptEntry${activity ? " transcriptEntry-activity" : ""}`
      return item.kind === "toolRun" ? (
        <div className={className} data-run-id={item.id}>
          <ToolRunCard
            run={item}
            active={busy && index === items.length - 1}
            expanded={expanded.has(item.id)}
            onExpandedChange={setEntryExpanded}
          />
        </div>
      ) : (
        <div
          className={`${className}${expandedEntries.has(item.id) ? " transcriptEntry-inRun" : ""}`}
          data-entry-id={item.id}
        >
          <EntryView
            entry={item}
            active={busy && index === items.length - 1}
            thinkingVisible={thinkingVisible}
            expanded={expanded.has(item.id)}
            onExpandedChange={setEntryExpanded}
          />
        </div>
      )
    },
    [busy, items, thinkingVisible, expanded, expandedEntries, setEntryExpanded],
  )

  return (
    <div className="transcriptViewport">
      {/* Steady thumb while a turn streams: event-driven reveals flicker with the follow jumps,
          and a hidden thumb reads as "the scrollbar is gone" when the pointer sits on the
          composer. */}
      <Virtuoso<TranscriptItem, ListContext>
        scrollerRef={scroll.scrollerRef}
        onScrollCapture={scroll.onScrollCapture}
        onWheelCapture={scroll.onWheelCapture}
        onKeyDown={scroll.onKeyDown}
        onPointerDownCapture={scroll.onPointerDownCapture}
        onTouchStartCapture={scroll.onTouchStartCapture}
        onTouchMoveCapture={scroll.onTouchMoveCapture}
        totalListHeightChanged={scroll.totalListHeightChanged}
        className={`transcriptScroll${scroll.scrolling || busy ? " scrolling" : ""}`}
        data={items}
        computeItemKey={itemKey}
        components={components}
        context={context}
        itemContent={renderEntry}
        initialTopMostItemIndex={initialPosition}
        defaultItemHeight={80}
        increaseViewportBy={300}
        isScrolling={scroll.isScrolling}
      />
      {!scroll.atBottom && visible.length > 0 ? (
        <button type="button" className="jumpToLatest" onClick={scroll.jumpToLatest}>
          <Icon icon={ArrowDown} size={12} /> Latest
        </button>
      ) : null}
    </div>
  )
})
