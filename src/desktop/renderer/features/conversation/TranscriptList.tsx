import { ArrowDown, ChevronsDownUp, ChevronsUpDown, Sparkles, X } from "lucide-react"
import {
  type ComponentProps,
  type CSSProperties,
  forwardRef,
  memo,
  type ReactNode,
  type UIEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso"
import type { TranscriptEntry, TranscriptNote } from "../../../../app/transcript.js"
import type { AnswerLevel } from "../../../contracts.js"
import { IconButton } from "../../components/Button.js"
import { Icon } from "../../components/Icon.js"
import { Markdown } from "../../components/Markdown.js"
import { useI18n } from "../../i18n/index.js"
import { useDesktop } from "../../runtime.js"
import {
  clearHighlights,
  type FindRequest,
  matchOffsets,
  setHighlights,
  textRanges,
} from "../canvas/find.js"
import { artifactTitle, EntryView } from "./entries.js"
import { parseDiffDisplay, shownArtifact, ToolRunCard } from "./ToolCard.js"
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
 * the live status, and so does a tool call that found nothing.
 */
function visibleEntries(entries: TranscriptEntry[], thinkingVisible: boolean): TranscriptEntry[] {
  const visible = entries.filter((entry) => {
    if (entry.kind === "reasoning") return thinkingVisible || entry.streaming === true
    if (entry.kind === "tool") return entry.outcome !== "empty"
    if (entry.kind === "message" && entry.speaker === "Otis")
      return !!entry.text.trim() || !!entry.artifacts?.length
    return true
  })
  return visible.length === entries.length ? entries : visible
}

/**
 * A ready Canvas artifact stands on its own as its card; every other tool entry, edits included,
 * is activity that condenses into a run.
 */
function isActivity(entry: TranscriptEntry): boolean {
  return entry.kind === "tool" && !shownArtifact(entry)
}

/**
 * Consecutive tool cards collapse into one run row: the reads, searches, edits and commands
 * between two of Otis's messages become one line that sums them up, edits with their lines
 * changed, so a session of many changes stays readable. Opening the run lists every action, an
 * edit's patch a click away, and the Changes tab keeps every patch of the session. Single tools
 * render as they always have.
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

/** Scrolling this far with ⌘ held takes one length step. */
const ZOOM_STEP = 60

const VERSION_LABELS = {
  2: "zoom.thoroughVersion",
  1: "zoom.longerVersion",
  [-1]: "zoom.shortVersion",
  [-2]: "zoom.oneSentenceVersion",
} as const

/**
 * An answer's length, picked in the column's left margin beside its first line: Shorter and
 * Longer, there while the answer is hovered or focused and faintly while it shows another length
 * than its own. Only then does a caption under it take a line, saying which version shows, with
 * the way back.
 */
function AnswerLength({
  level,
  onPick,
}: {
  level: AnswerLevel
  onPick: (level: AnswerLevel) => void
}) {
  const { t } = useI18n()
  return (
    <>
      <fieldset
        aria-label={t("zoom.length")}
        className={`answerLength${level === 0 ? "" : " answerLength-zoomed"}`}
      >
        <IconButton
          icon={ChevronsUpDown}
          label={t("zoom.longer")}
          size={20}
          disabled={level === 2}
          onClick={() => onPick((level + 1) as AnswerLevel)}
        />
        <IconButton
          icon={ChevronsDownUp}
          label={t("zoom.shorter")}
          size={20}
          disabled={level === -2}
          onClick={() => onPick((level - 1) as AnswerLevel)}
        />
      </fieldset>
      {level !== 0 ? (
        <p className="answerLength-caption">
          <span>{t(VERSION_LABELS[level])}</span>
          <span aria-hidden>·</span>
          <button type="button" onClick={() => onPick(0)}>
            {t("zoom.showOriginal")}
          </button>
        </p>
      ) : null}
    </>
  )
}

/**
 * A phrase selected in an answer, waiting for its Explain button: the row, and where the
 * selection's first line starts and centers in it.
 */
type NotePick = { entry: number; quote: string; top: number; left: number }

const NOTE_HIGHLIGHT = "otis-note"
const noteOwners = new Map<object, Range[]>()

/** Paints every transcript's noted phrases; an empty list removes an owner's. */
function paintNotes(owner: object, ranges: Range[]) {
  if (ranges.length === 0) noteOwners.delete(owner)
  else noteOwners.set(owner, ranges)
  const registry = (CSS as { highlights?: HighlightRegistry }).highlights
  registry?.set(NOTE_HIGHLIGHT, new Highlight(...[...noteOwners.values()].flat()))
}

/** Marks the noted phrase whose note the pointer is on, over its plain mark, or none. */
function paintActive(range: Range | undefined) {
  const registry = (CSS as { highlights?: HighlightRegistry }).highlights
  if (range) registry?.set("otis-note-active", new Highlight(range))
  else registry?.delete("otis-note-active")
}

/**
 * A note, folded to a few lines with Show all, as the margin has little room; one that failed to
 * be written says why and can be tried again.
 */
function MarginNoteCard({
  note,
  top,
  active,
  onRemove,
  onResize,
  onRetry,
}: {
  note: TranscriptNote
  top?: number
  active: boolean
  onRemove: () => void
  /** Called when the card's height changes, so the notes below it move down or up. */
  onResize: () => void
  onRetry: () => void
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  // Show all appears only for a note the fold actually cuts, which depends on its column.
  const text = useRef<HTMLDivElement>(null)
  const card = useRef<HTMLElement>(null)
  const height = useRef(0)
  const [cut, setCut] = useState(false)
  useLayoutEffect(() => {
    const element = text.current
    if (element && !open) setCut(element.scrollHeight > element.clientHeight + 1)
    const next = card.current?.offsetHeight ?? 0
    if (next === height.current) return
    height.current = next
    onResize()
  })
  return (
    <aside
      ref={card}
      data-note-id={note.id}
      className={`marginNote${note.error ? " marginNote-error" : ""}${
        note.text === undefined && !note.error ? " marginNote-writing" : ""
      }${active ? " marginNote-active" : ""}`}
      style={top === undefined ? undefined : ({ "--note-top": `${top}px` } as CSSProperties)}
    >
      <div
        ref={text}
        className={`marginNote-text${
          open ? "" : ` marginNote-folded${cut ? " marginNote-cut" : ""}`
        }`}
      >
        {note.text === undefined ? (
          (note.error ?? t("notes.writing"))
        ) : (
          <Markdown text={note.text} />
        )}
      </div>
      {note.error ? (
        <div className="marginNote-footer">
          <button type="button" className="marginNote-link" onClick={onRetry}>
            {t("notes.retry")}
          </button>
        </div>
      ) : null}
      {note.text !== undefined && (cut || open) ? (
        <div className="marginNote-footer">
          <button type="button" className="marginNote-link" onClick={() => setOpen(!open)}>
            {t(open ? "notes.showLess" : "notes.showAll")}
          </button>
        </div>
      ) : null}
      <IconButton
        icon={X}
        label={t("notes.remove")}
        size={20}
        className="marginNote-remove"
        onClick={onRemove}
      />
    </aside>
  )
}

export const TranscriptList = memo(function TranscriptList({
  entries,
  thinkingVisible,
  busy = false,
  footer,
  find,
  onFindCount,
  rail = false,
  onBranch,
  runtime,
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
  /** Branches the pane's session at a finished turn; absent where branching is not offered. */
  onBranch?: (turnSeq: number) => void
  /** The pane's session, which writes margin notes on its answers; absent, none are offered. */
  runtime?: number
}) {
  const { t } = useI18n()
  const { api } = useDesktop()
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
  // DOM, and over what a row shows: a folded run, thought or patch stays out until it is opened.
  // The current occurrence's row scrolls to the middle of the view and following the tail stops.
  const query = find?.query ?? ""
  const counts = useMemo(() => {
    if (!query) return NO_MATCHES
    return items.map((item) => {
      if (item.kind === "toolRun" || (item.kind === "reasoning" && !expanded.has(item.id))) return 0
      const shown = item.diff
        ? [item.text]
        : [
            item.messageText ?? item.text,
            ...(item.images ?? []),
            ...(item.artifacts ?? []).map(artifactTitle),
          ]
      if (item.diff && expanded.has(item.id))
        shown.push(...parseDiffDisplay(item.diff).map((row) => ("text" in row ? row.text : "")))
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

  // Selecting a phrase inside a settled answer offers an Explain button just above it. Otis writes
  // the note and keeps it with the session; the answer's entry carries it here, as it does the
  // answer's other lengths.
  const [pick, setPick] = useState<NotePick>()
  const [noteTops, setNoteTops] = useState<ReadonlyMap<string, number>>(() => new Map())
  const [noteLayout, setNoteLayout] = useState(0)
  const relayoutNotes = useCallback(() => setNoteLayout((tick) => tick + 1), [])
  const answerOf = useCallback(
    (id: number) => visible.find((entry) => entry.id === id)?.answer,
    [visible],
  )
  const onMouseUp = useCallback(() => {
    if (runtime === undefined) return
    const selection = window.getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined
    // A drag that starts or ends inside a word takes the whole word, as a highlighter would.
    const word = /[\p{L}\p{N}]/u
    if (range && !range.collapsed) {
      const { startContainer: start, endContainer: end } = range
      if (start instanceof Text) {
        let offset = range.startOffset
        while (offset > 0 && word.test(start.data[offset - 1])) offset--
        range.setStart(start, offset)
      }
      if (end instanceof Text) {
        let offset = range.endOffset
        while (offset < end.data.length && word.test(end.data[offset])) offset++
        range.setEnd(end, offset)
      }
    }
    const quote = range?.toString().trim() ?? ""
    const container = range?.commonAncestorContainer
    const message = (container instanceof Element ? container : container?.parentElement)?.closest(
      ".assistantMessage",
    )
    const row = message?.closest<HTMLElement>(".transcriptEntry[data-entry-id]")
    const entry = Number(row?.dataset.entryId)
    if (!range || !row || !answerOf(entry) || !quote || quote.length > 1_000) {
      setPick(undefined)
      return
    }
    // Above the middle of the selection's first line, where the eye already is.
    const line = range.getClientRects()[0] ?? range.getBoundingClientRect()
    const box = row.getBoundingClientRect()
    setPick({ entry, quote, top: line.top - box.top, left: line.left + line.width / 2 - box.left })
  }, [runtime, answerOf])
  useEffect(() => {
    const root = viewport.current
    root?.addEventListener("mouseup", onMouseUp)
    return () => root?.removeEventListener("mouseup", onMouseUp)
  }, [onMouseUp])
  const addNote = useCallback(
    (picked: NotePick) => {
      const answer = answerOf(picked.entry)
      if (runtime === undefined || !answer) return
      setPick(undefined)
      window.getSelection()?.removeAllRanges()
      void api.addNote(runtime, answer, picked.quote)
    },
    [api, runtime, answerOf],
  )
  const writeNote = useCallback(
    (id: string) => {
      if (runtime !== undefined) void api.writeNote(runtime, id)
    },
    [api, runtime],
  )
  const removeNote = useCallback(
    (id: string) => {
      if (runtime !== undefined) void api.removeNote(runtime, id)
    },
    [api, runtime],
  )
  const setAnswerLength = useCallback(
    (entry: number, level: AnswerLevel) => {
      const answer = answerOf(entry)
      if (runtime !== undefined && answer) void api.setAnswerLength(runtime, answer, level)
    },
    [api, runtime, answerOf],
  )
  // ⌘ with the wheel over an answer previews its length a step per stretch of scrolling, up for
  // longer and down for shorter; the length the wheel rests on is the one asked for, so passing
  // through the others writes nothing.
  const [preview, setPreview] = useState<{ entry: number; level: AnswerLevel }>()
  const wheel = useRef<{
    preview?: { entry: number; level: AnswerLevel }
    delta: number
    timer?: ReturnType<typeof setTimeout>
  }>({ delta: 0 })
  useEffect(() => {
    const root = viewport.current
    if (!root || runtime === undefined) return
    const onWheel = (event: WheelEvent) => {
      if (!event.metaKey && !event.ctrlKey) return
      const target = event.target instanceof Element ? event.target : null
      const row = target
        ?.closest(".assistantMessage")
        ?.closest<HTMLElement>(".transcriptEntry[data-entry-id]")
      const entry = visible.find((each) => each.id === Number(row?.dataset.entryId))
      if (!entry?.answer) return
      event.preventDefault()
      const state = wheel.current
      if (state.preview?.entry !== entry.id) {
        state.preview = undefined
        state.delta = 0
      }
      state.delta += event.deltaY
      if (Math.abs(state.delta) < ZOOM_STEP) return
      const from = state.preview?.level ?? entry.zoom?.writing ?? entry.zoom?.level ?? 0
      const level = Math.min(2, Math.max(-2, from + (state.delta < 0 ? 1 : -1))) as AnswerLevel
      state.delta = 0
      state.preview = { entry: entry.id, level }
      setPreview(state.preview)
      clearTimeout(state.timer)
      state.timer = setTimeout(() => {
        state.preview = undefined
        setPreview(undefined)
        setAnswerLength(entry.id, level)
      }, 350)
    }
    root.addEventListener("wheel", onWheel, { passive: false })
    return () => root.removeEventListener("wheel", onWheel)
  }, [runtime, visible, setAnswerLength])
  // Pointing at a noted phrase or at its note marks both, so notes side by side are told apart.
  // A highlight is no element, so the phrase under the pointer is found from its measured lines.
  const [activeNote, setActiveNote] = useState<string>()
  const active = useRef<string>(undefined)
  const noteRanges = useRef(new Map<string, Range>())
  // Noted phrases are found again in the mounted rows after each change, since rows remount as
  // they scroll in, and each note sits level with its phrase's first line. A note belongs to its
  // answer's own text, so it waits while the answer shows another length.
  useEffect(() => {
    const root = scroll.scroller.current
    if (!root) return
    const frame = requestAnimationFrame(() => {
      const ranges = new Map<string, Range>()
      const tops = new Map<string, number>()
      // In the margin a note that would overlap the one above it, of this answer or an earlier
      // one, starts below it; positions are compared on screen and kept relative to each row.
      let bottom = -Infinity
      for (const entry of visible) {
        if (!entry.notes?.length || (entry.zoom?.level ?? 0) !== 0) continue
        const row = root.querySelector<HTMLElement>(`.transcriptEntry[data-entry-id="${entry.id}"]`)
        const message = row?.querySelector(".assistantMessage")
        if (!row || !message) continue
        const rowTop = row.getBoundingClientRect().top
        const placed: { id: string; top: number }[] = []
        for (const note of entry.notes) {
          // The phrase's range in the answer, across inline formatting and between blocks, as a
          // selection reads it: runs of whitespace count as one space, and a new block starts
          // with one.
          const needle = note.quote.replace(/\s+/g, " ").trim()
          if (!needle) continue
          const walker = document.createTreeWalker(message, NodeFilter.SHOW_TEXT)
          const at: { node: Text; offset: number }[] = []
          let text = ""
          let block: Element | null = null
          for (
            let node = walker.nextNode() as Text | null;
            node;
            node = walker.nextNode() as Text | null
          ) {
            const parent =
              node.parentElement?.closest("p, li, h1, h2, h3, h4, h5, h6, pre, td, th") ?? null
            if (block && parent !== block && !text.endsWith(" ")) {
              text += " "
              at.push({ node, offset: 0 })
            }
            block = parent
            for (let offset = 0; offset < node.data.length; offset++) {
              const space = /\s/.test(node.data[offset])
              if (space && (text === "" || text.endsWith(" "))) continue
              text += space ? " " : node.data[offset]
              at.push({ node, offset })
            }
          }
          const start = text.indexOf(needle)
          if (start < 0) continue
          const first = at[start]
          const last = at[start + needle.length - 1]
          const range = new Range()
          range.setStart(first.node, first.offset)
          range.setEnd(last.node, last.offset + 1)
          ranges.set(note.id, range)
          placed.push({ id: note.id, top: range.getBoundingClientRect().top })
        }
        for (const { id, top } of placed.sort((a, b) => a.top - b.top)) {
          const at = Math.max(top, bottom + 10)
          tops.set(id, at - rowTop)
          const card = root.querySelector<HTMLElement>(`.marginNote[data-note-id="${id}"]`)
          bottom = at + (card?.offsetHeight ?? 0)
        }
      }
      noteRanges.current = ranges
      paintNotes(root, [...ranges.values()])
      // Rows remount as they scroll; a pointed-at phrase is marked again where it now is.
      if (active.current !== undefined) paintActive(ranges.get(active.current))
      setNoteTops((previous) =>
        previous.size === tops.size && [...tops].every(([id, top]) => previous.get(id) === top)
          ? previous
          : tops,
      )
    })
    return () => cancelAnimationFrame(frame)
  }, [visible, items, scroll.scrolling, scroll.scroller, noteLayout])
  useEffect(() => {
    const root = scroll.scroller.current
    return () => {
      if (root) paintNotes(root, [])
      if (active.current !== undefined) paintActive(undefined)
    }
  }, [scroll.scroller])
  useEffect(() => {
    const root = viewport.current
    if (!root || runtime === undefined) return
    const point = (id: string | undefined) => {
      if (id === active.current) return
      active.current = id
      setActiveNote(id)
      paintActive(id === undefined ? undefined : noteRanges.current.get(id))
    }
    const onMove = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null
      const card = target?.closest<HTMLElement>(".marginNote")
      if (card) return point(card.dataset.noteId)
      const under = ({ left, right, top, bottom }: DOMRect) =>
        event.clientX >= left &&
        event.clientX <= right &&
        event.clientY >= top &&
        event.clientY <= bottom
      const phrase = target?.closest(".assistantMessage")
        ? [...noteRanges.current].find(([, range]) => [...range.getClientRects()].some(under))
        : undefined
      point(phrase?.[0])
    }
    const onLeave = () => point(undefined)
    root.addEventListener("pointermove", onMove)
    root.addEventListener("pointerleave", onLeave)
    return () => {
      root.removeEventListener("pointermove", onMove)
      root.removeEventListener("pointerleave", onLeave)
    }
  }, [runtime])

  const renderEntry = useCallback(
    (index: number, item: TranscriptItem) => {
      const zoom = item.kind === "toolRun" ? undefined : item.zoom
      const shownLevel = zoom?.level ?? 0
      // The length asked for: the wheel's while it turns, else the one being written, else shown.
      const target =
        item.kind !== "toolRun" && preview?.entry === item.id
          ? preview.level
          : (zoom?.writing ?? shownLevel)
      const zoomed = zoom && shownLevel !== 0 ? zoom.texts[shownLevel] : undefined
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
          className={`${className}${expandedEntries.has(item.id) ? " transcriptEntry-inRun" : ""}${
            target !== shownLevel ? " transcriptEntry-zooming" : ""
          }`}
          data-entry-id={item.id}
          data-index={index}
          aria-current={found}
        >
          <EntryView
            entry={zoomed === undefined ? item : { ...item, text: zoomed }}
            active={busy && index === items.length - 1}
            thinkingVisible={thinkingVisible}
            expanded={expanded.has(item.id)}
            onExpandedChange={setEntryExpanded}
            onBranch={onBranch}
          />
          {runtime !== undefined && item.answer ? (
            <AnswerLength level={target} onPick={(level) => setAnswerLength(item.id, level)} />
          ) : null}
          {zoom?.error ? <p className="answerZoom-error">{zoom.error}</p> : null}
          {/* A selected phrase's Explain button just above it, and the answer's notes: beside the
              column where the view is wide enough, each level with its phrase, else under it. */}
          {runtime !== undefined && item.answer && shownLevel === 0 && pick?.entry === item.id ? (
            <button
              type="button"
              className="marginNote-add"
              style={{ top: pick.top, left: pick.left }}
              title={t("notes.explainTitle")}
              // Pressing must not clear the selection before the click reads it.
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => addNote(pick)}
            >
              <Icon icon={Sparkles} size={13} />
              {t("notes.explain")}
            </button>
          ) : null}
          {runtime !== undefined && item.answer && shownLevel === 0 && item.notes?.length ? (
            <div className="marginNotes">
              {item.notes.map((note) => (
                <MarginNoteCard
                  key={note.id}
                  note={note}
                  top={noteTops.get(note.id)}
                  active={note.id === activeNote}
                  onRemove={() => removeNote(note.id)}
                  onResize={relayoutNotes}
                  onRetry={() => writeNote(note.id)}
                />
              ))}
            </div>
          ) : null}
        </div>
      )
    },
    [
      busy,
      items,
      thinkingVisible,
      expanded,
      expandedEntries,
      setEntryExpanded,
      current,
      onBranch,
      runtime,
      noteTops,
      pick,
      preview,
      addNote,
      removeNote,
      relayoutNotes,
      writeNote,
      setAnswerLength,
      activeNote,
      t,
    ],
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
