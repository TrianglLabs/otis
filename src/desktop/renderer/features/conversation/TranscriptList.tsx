import { ArrowDown } from "lucide-react"
import {
  type ComponentProps,
  type CSSProperties,
  forwardRef,
  memo,
  type ReactNode,
  type UIEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso"
import type { TranscriptEntry } from "../../../../app/transcript.js"
import { Icon } from "../../components/Icon.js"
import { useI18n } from "../../i18n/index.js"
import {
  clearHighlights,
  type FindRequest,
  matchOffsets,
  setHighlights,
  textRanges,
} from "../canvas/find.js"
import { artifactTitle, EntryView } from "./entries.js"
import { parseDiffDisplay, ToolRunCard } from "./ToolCard.js"
import { isAtBottom, useTranscriptScroll } from "./useTranscriptScroll.js"

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
const NO_MATCHES: number[] = []

export const TranscriptList = memo(function TranscriptList({
  entries,
  thinkingVisible,
  busy = false,
  footer,
  find,
  onFindCount,
  rail = false,
}: {
  entries: TranscriptEntry[]
  thinkingVisible: boolean
  busy?: boolean
  footer?: ReactNode
  /** Find in session: the query and which matching row, in order, is the current one. */
  find?: FindRequest
  onFindCount?: (count: number) => void
  /** The turn rail at the edge: one mark per user turn, for a session shown on its own. */
  rail?: boolean
}) {
  const { t } = useI18n()
  const visible = useMemo(
    () => visibleEntries(entries, thinkingVisible),
    [entries, thinkingVisible],
  )
  const scroll = useTranscriptScroll()
  // Disclosure state belongs to the transcript, so scrolling a row out of the viewport doesn't
  // collapse it. Opening one is reading, not following: the rows unfold under a header that
  // stays put instead of the tail pulling the view down.
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set())
  const setEntryExpanded = useCallback(
    (id: number, open: boolean) => {
      if (open) scroll.pauseFollowing()
      setExpanded((previous) => {
        const next = new Set(previous)
        if (open) next.add(id)
        else next.delete(id)
        return next
      })
    },
    [scroll.pauseFollowing],
  )
  // Expanded runs flatten into ordinary rows, so a long run stays windowed like the rest of the
  // transcript.
  const { items, expandedEntries } = useMemo(
    () => flattenExpandedRuns(groupToolRuns(visible), expanded),
    [visible, expanded],
  )
  const context = useMemo(() => ({ footer }), [footer])

  // The rail lists the user's turns by the row each starts at. The turn in view is the one at the
  // top edge, or the last at the tail; rows above the window are not mounted, so the first mounted
  // row across the edge stands for the turn it belongs to. A clicked turn stays lit until the
  // reader's own input, since the transcript may not reach far enough to bring it to the top.
  const turns = useMemo(
    () =>
      items.flatMap((item, index) => {
        if (item.kind !== "message" || item.speaker !== "You") return []
        const words = (item.messageText ?? item.text).trim().split("\n")[0]
        const first = item.artifacts?.[0]
        return [
          {
            index,
            id: item.id,
            label: words || item.images?.[0] || (first && artifactTitle(first)) || "",
          },
        ]
      }),
    [items],
  )
  const showRail = rail && turns.length >= 3 && !(scroll.atTop && scroll.atBottom)
  const [turnInView, setTurnInView] = useState<number | undefined>()
  const pinned = useRef(false)
  const locateTurn = useCallback(
    (scroller: HTMLElement) => {
      if (pinned.current) return
      if (isAtBottom(scroller)) {
        setTurnInView(turns.at(-1)?.id)
        return
      }
      const mark = scroller.getBoundingClientRect().top + 16
      for (const row of scroller.querySelectorAll<HTMLElement>(".transcriptEntry")) {
        if (row.getBoundingClientRect().bottom < mark) continue
        const index = Number(row.dataset.index)
        setTurnInView((turns.findLast((turn) => turn.index <= index) ?? turns[0])?.id)
        return
      }
    },
    [turns],
  )
  const onScrollCapture = useCallback(
    (event: UIEvent<HTMLElement>) => {
      scroll.onScrollCapture(event)
      if (showRail && event.target === event.currentTarget) locateTurn(event.currentTarget)
    },
    [scroll.onScrollCapture, showRail, locateTurn],
  )

  // Occurrences are counted per row over the rows' data, since only the visible slice is in the
  // DOM, and over what a row shows: a folded run or thought stays out until it is opened. The
  // current occurrence's row scrolls to the middle of the view and following the tail stops.
  const query = find?.query ?? ""
  const counts = useMemo(() => {
    if (!query) return NO_MATCHES
    return items.map((item) => {
      if (item.kind === "toolRun" || (item.kind === "reasoning" && !expanded.has(item.id))) return 0
      const shown = item.diff
        ? [item.text, ...parseDiffDisplay(item.diff).map((row) => ("text" in row ? row.text : ""))]
        : [
            item.messageText ?? item.text,
            ...(item.images ?? []),
            ...(item.artifacts ?? []).map(artifactTitle),
          ]
      return matchOffsets(shown.join("\n"), query).length
    })
  }, [items, query, expanded])
  const total = counts.reduce((sum, count) => sum + count, 0)
  useEffect(() => {
    onFindCount?.(total)
  }, [total, onFindCount])
  let current: number | undefined
  let within = find?.index ?? 0
  for (let row = 0; row < counts.length && current === undefined; row++) {
    if (within < counts[row]) current = row
    else within -= counts[row]
  }
  const virtuoso = useRef<VirtuosoHandle>(null)
  const viewport = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (showRail && scroll.scroller.current) locateTurn(scroll.scroller.current)
  }, [showRail, locateTurn, scroll.scroller])
  // A rail that hides and returns starts unpinned, so the turn in view is located afresh.
  useEffect(() => {
    const root = viewport.current
    if (!root || !showRail) return
    const unpin = (event: Event) => {
      if (event.target instanceof Element && event.target.closest(".turnRail")) return
      pinned.current = false
    }
    const options = { capture: true, passive: true }
    for (const type of ["wheel", "keydown", "touchmove", "pointerdown"]) {
      root.addEventListener(type, unpin, options)
    }
    return () => {
      for (const type of ["wheel", "keydown", "touchmove", "pointerdown"]) {
        root.removeEventListener(type, unpin, options)
      }
      pinned.current = false
    }
  }, [showRail])
  useEffect(() => {
    if (current === undefined) return
    scroll.pauseFollowing()
    virtuoso.current?.scrollToIndex({ index: current, align: "center" })
  }, [current, scroll.pauseFollowing])
  // Every occurrence in the mounted rows is painted, the current one in the stronger color: the
  // one at the same position in its row when the rendered text has as many as the data (Markdown
  // can hide some), else the whole row's. Rows mount after the scroll settles, so painting waits a
  // frame; rows that mount during a scroll are painted when it ends. While a query is open, each
  // transcript change walks the mounted rows' text again, which is the cost of painting what is
  // on screen.
  useEffect(() => {
    const root = scroll.scroller.current
    if (!root) return
    if (!query) {
      clearHighlights(root)
      return
    }
    const frame = requestAnimationFrame(() => {
      const ranges = textRanges(root, query)
      const row = current === undefined ? null : root.querySelector(`[aria-current="true"]`)
      const own = row ? ranges.filter((range) => row.contains(range.startContainer)) : []
      const exact =
        current !== undefined && own.length === counts[current] ? own[within] : undefined
      setHighlights(root, ranges, exact ? [exact] : own)
    })
    return () => cancelAnimationFrame(frame)
  }, [query, current, within, counts, items, scroll.scrolling, scroll.scroller])
  useEffect(() => {
    const root = scroll.scroller.current
    return () => {
      if (root) clearHighlights(root)
    }
  }, [scroll.scroller])

  const renderEntry = useCallback(
    (index: number, item: TranscriptItem) => {
      // Neighbor-aware spacing belongs inside each measured row, including flattened run entries.
      const activity = isActivityRow(item) && isActivityRow(items[index + 1])
      const className = `transcriptEntry${activity ? " transcriptEntry-activity" : ""}`
      const found = index === current ? true : undefined
      return item.kind === "toolRun" ? (
        <div className={className} data-run-id={item.id} data-index={index} aria-current={found}>
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
          data-index={index}
          aria-current={found}
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
    [busy, items, thinkingVisible, expanded, expandedEntries, setEntryExpanded, current],
  )

  return (
    <div className="transcriptViewport" ref={viewport}>
      {/* Steady thumb while a turn streams: event-driven reveals flicker with the follow jumps,
          and a hidden thumb reads as "the scrollbar is gone" when the pointer sits on the
          composer. */}
      <Virtuoso<TranscriptItem, ListContext>
        ref={virtuoso}
        scrollerRef={scroll.scrollerRef}
        onScrollCapture={onScrollCapture}
        onWheelCapture={scroll.onWheelCapture}
        onKeyDown={scroll.onKeyDown}
        onPointerDownCapture={scroll.onPointerDownCapture}
        onTouchStartCapture={scroll.onTouchStartCapture}
        onTouchMoveCapture={scroll.onTouchMoveCapture}
        totalListHeightChanged={scroll.totalListHeightChanged}
        className={`transcriptScroll${scroll.scrolling || busy ? " scrolling" : ""}${
          scroll.atTop ? "" : " transcriptScroll-above"
        }${scroll.atBottom ? "" : " transcriptScroll-below"}`}
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
      {showRail ? (
        <nav
          className="turnRail"
          aria-label={t("transcript.turns")}
          style={{ "--turns": turns.length } as CSSProperties}
        >
          {turns.map((turn) => (
            <button
              key={turn.id}
              type="button"
              className={`turnRail-tick${turn.id === turnInView ? " turnRail-tick-current" : ""}`}
              aria-label={turn.label}
              aria-current={turn.id === turnInView ? "step" : undefined}
              onClick={() => {
                pinned.current = true
                setTurnInView(turn.id)
                scroll.pauseFollowing()
                const scroller = scroll.scroller.current
                const row = scroller?.querySelector<HTMLElement>(
                  `.transcriptEntry[data-index="${turn.index}"]`,
                )
                if (!scroller || !row) {
                  // Off screen: the list estimates the position and corrects it as rows measure.
                  virtuoso.current?.scrollToIndex({
                    index: turn.index,
                    align: "start",
                    offset: -28,
                  })
                  return
                }
                // A mounted row goes by its measured position, clear of the top haze. One within
                // a window of the tail cannot reach the top: the view stays there, and so does
                // following, rather than the list retrying against every streamed delta.
                scroller.scrollTop +=
                  row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 28
                if (isAtBottom(scroller)) scroll.jumpToLatest()
              }}
            >
              <span className="turnRail-label" aria-hidden="true">
                {turn.label}
              </span>
            </button>
          ))}
        </nav>
      ) : null}
    </div>
  )
})
