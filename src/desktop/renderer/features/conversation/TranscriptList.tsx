import { ArrowDown } from "lucide-react"
import { type ComponentProps, forwardRef, memo, type ReactNode, useCallback, useMemo, useState } from "react"
import { Virtuoso } from "react-virtuoso"
import type { TranscriptEntry } from "../../../../app/transcript.js"
import { Icon } from "../../components/Icon.js"
import { EntryView } from "./entries.js"
import { ToolRunCard } from "./ToolCard.js"
import { flattenExpandedRuns, groupToolRuns, type TranscriptItem } from "./tool-runs.js"
import { useTranscriptScroll } from "./useTranscriptScroll.js"
import { visibleEntries } from "./visible-entries.js"

type ListContext = { footer?: ReactNode }

// Keep component types outside the render path: a new List/Footer type remounts the visible conversation.
const List = forwardRef<HTMLDivElement, ComponentProps<"div"> & { context?: ListContext }>(function List(
  { context: _context, ...props },
  ref,
) {
  return <div {...props} className="transcript" ref={ref} />
})
function Footer({ context }: { context?: ListContext }) {
  return <div className="transcriptFooter">{context?.footer}</div>
}
function Header() {
  return <div style={{ height: 24 }} />
}
const components = { List, Header, Footer }
// A run's id is its first entry's id; when the run is expanded, that entry follows the run's row as its own
// item — so run rows key with a prefix to never collide with entry rows.
const itemKey = (_index: number, item: TranscriptItem) => (item.kind === "toolRun" ? `run-${item.id}` : item.id)
const initialPosition = { index: "LAST", align: "end" } as const

/** Only the visible slice mounts. Virtuoso measures rows; the scroll hook owns following the live tail. */
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
  const visible = useMemo(() => visibleEntries(entries, thinkingVisible), [entries, thinkingVisible])
  const scroll = useTranscriptScroll()
  const [scrolling, setScrolling] = useState(false)
  // Disclosure state belongs to the transcript, so scrolling a row out of the viewport doesn't collapse it.
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set())
  const setEntryExpanded = useCallback((id: number, open: boolean) => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (open) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])
  // Expanded runs flatten into ordinary rows, so a long run stays windowed like the rest of the transcript.
  const { items, expandedEntries } = useMemo(
    () => flattenExpandedRuns(groupToolRuns(visible), expanded),
    [visible, expanded],
  )
  const context = useMemo(() => ({ footer }), [footer])
  const renderEntry = useCallback(
    (index: number, item: TranscriptItem) =>
      item.kind === "toolRun" ? (
        <div className="transcriptEntry" data-run-id={item.id}>
          <ToolRunCard
            run={item}
            active={busy && index === items.length - 1}
            expanded={expanded.has(item.id)}
            onExpandedChange={setEntryExpanded}
          />
        </div>
      ) : (
        <div
          className={`transcriptEntry${expandedEntries.has(item.id) ? " transcriptEntry-inRun" : ""}`}
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
      ),
    [busy, items.length, thinkingVisible, expanded, expandedEntries, setEntryExpanded],
  )

  return (
    <div className="transcriptViewport">
      <Virtuoso<TranscriptItem, ListContext>
        scrollerRef={scroll.scrollerRef}
        onScrollCapture={scroll.onScrollCapture}
        totalListHeightChanged={scroll.totalListHeightChanged}
        className={`transcriptScroll${scrolling ? " scrolling" : ""}`}
        data={items}
        computeItemKey={itemKey}
        components={components}
        context={context}
        itemContent={renderEntry}
        initialTopMostItemIndex={initialPosition}
        defaultItemHeight={80}
        increaseViewportBy={300}
        isScrolling={setScrolling}
      />
      {!scroll.atBottom && visible.length > 0 ? (
        <button type="button" className="jumpToLatest" onClick={scroll.jumpToLatest}>
          <Icon icon={ArrowDown} size={12} /> Latest
        </button>
      ) : null}
    </div>
  )
})
