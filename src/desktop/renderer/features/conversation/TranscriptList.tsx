import { ArrowDown } from "lucide-react"
import { type ComponentProps, forwardRef, memo, type ReactNode, useCallback, useMemo, useState } from "react"
import { Virtuoso } from "react-virtuoso"
import type { TranscriptEntry } from "../../../../app/transcript.js"
import { Icon } from "../../components/Icon.js"
import { EntryView } from "./entries.js"
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
const itemKey = (_index: number, entry: TranscriptEntry) => entry.id
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
  const context = useMemo(() => ({ footer }), [footer])
  const renderEntry = useCallback(
    (index: number, entry: TranscriptEntry) => (
      <div className="transcriptEntry" data-entry-id={entry.id}>
        <EntryView
          entry={entry}
          active={busy && index === visible.length - 1}
          thinkingVisible={thinkingVisible}
          expanded={expanded.has(entry.id)}
          onExpandedChange={setEntryExpanded}
        />
      </div>
    ),
    [busy, visible.length, thinkingVisible, expanded, setEntryExpanded],
  )

  return (
    <div className="transcriptViewport">
      <Virtuoso<TranscriptEntry, ListContext>
        scrollerRef={scroll.scrollerRef}
        onScrollCapture={scroll.onScrollCapture}
        totalListHeightChanged={scroll.totalListHeightChanged}
        className={`transcriptScroll${scrolling ? " scrolling" : ""}`}
        data={visible}
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
