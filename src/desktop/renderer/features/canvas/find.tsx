import { ChevronDown, ChevronUp, X } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { IconButton } from "../../components/Button.js"
import { useI18n } from "../../i18n/index.js"

/**
 * Find in a Canvas document or a session's transcript. Matches are painted with the CSS Custom
 * Highlight API, so the content's own markup is never rewritten; each owner registers its ranges
 * and the registry repaints the union.
 */

/** The user's query and which of its occurrences, in document order, is the current one. */
export type FindRequest = { query: string; index: number }

/** One find bar's state: whether it is open, the query, and the current match with wraparound. */
export function useFind() {
  const [finding, setFinding] = useState(false)
  const [query, setQuery] = useState("")
  const [step, setStep] = useState(0)
  const [matchCount, setMatchCount] = useState(0)
  const [opened, setOpened] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  // The input exists once the bar has rendered; opening again while open selects what is typed.
  useEffect(() => {
    if (opened === 0) return
    input.current?.focus()
    input.current?.select()
  }, [opened])
  const open = useCallback(() => {
    setFinding(true)
    setOpened((count) => count + 1)
  }, [])
  const close = useCallback(() => setFinding(false), [])
  const type = useCallback((next: string) => {
    setQuery(next)
    setStep(0)
  }, [])
  const move = useCallback((by: number) => setStep((current) => current + by), [])
  // One object per state, so a memoized list taking it as a prop stays put between renders.
  const request = useMemo<FindRequest>(
    () => ({
      query: finding ? query : "",
      index: matchCount > 0 ? ((step % matchCount) + matchCount) % matchCount : 0,
    }),
    [finding, query, step, matchCount],
  )
  return { finding, query, matchCount, setMatchCount, input, request, open, close, type, move }
}

type Find = ReturnType<typeof useFind>

/** The bar: a bare field, the match count, previous and next, close. Enter steps, Escape closes. */
export function FindBar({
  find,
  label,
  placeholder,
  onClose,
  className,
}: {
  find: Find
  label: string
  placeholder: string
  onClose: () => void
  className?: string
}) {
  const { t } = useI18n()
  return (
    <search className={className ? `findBar ${className}` : "findBar"}>
      <input
        ref={find.input}
        type="text"
        className="findBar-input"
        aria-label={label}
        placeholder={placeholder}
        value={find.query}
        onChange={(event) => find.type(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") find.move(event.shiftKey ? -1 : 1)
          else if (event.key === "Escape") onClose()
          else return
          event.preventDefault()
        }}
        spellCheck={false}
        autoComplete="off"
      />
      <span className="findBar-count" aria-live="polite">
        {find.matchCount > 0
          ? t("canvas.findMatches", { index: find.request.index + 1, count: find.matchCount })
          : find.query
            ? t("canvas.findNone")
            : ""}
      </span>
      <IconButton
        icon={ChevronUp}
        label={t("canvas.findPrevious")}
        disabled={find.matchCount === 0}
        onClick={() => find.move(-1)}
      />
      <IconButton
        icon={ChevronDown}
        label={t("canvas.findNext")}
        disabled={find.matchCount === 0}
        onClick={() => find.move(1)}
      />
      <IconButton icon={X} label={t("canvas.findClose")} onClick={onClose} />
    </search>
  )
}

const MATCHES = "otis-find"
const CURRENT = "otis-find-current"
const owners = new Map<object, { ranges: Range[]; current: Range[] }>()

/** Start offsets of every case-insensitive occurrence of `query` in `text`. */
export function matchOffsets(text: string, query: string): number[] {
  if (!query) return []
  const haystack = text.toLowerCase()
  const needle = query.toLowerCase()
  const offsets: number[] = []
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1))
    offsets.push(at)
  return offsets
}

/** Ranges over the visible text of `root`, in document order; matches never span two nodes. */
export function textRanges(root: Node, query: string): Range[] {
  const ranges: Range[] = []
  if (!query) return ranges
  const walker = root.ownerDocument?.createTreeWalker(root, NodeFilter.SHOW_TEXT, (node) =>
    node.parentElement?.closest("script, style, template, [hidden]")
      ? NodeFilter.FILTER_REJECT
      : NodeFilter.FILTER_ACCEPT,
  )
  for (let node = walker?.nextNode(); node; node = walker?.nextNode()) {
    for (const offset of matchOffsets(node.textContent ?? "", query)) {
      const range = new Range()
      range.setStart(node, offset)
      range.setEnd(node, offset + query.length)
      ranges.push(range)
    }
  }
  return ranges
}

/**
 * Paints an owner's matches; an empty list, or `clearHighlights`, removes them. The current match
 * may span several ranges, as PDF text does across its runs.
 */
export function setHighlights(owner: object, ranges: Range[], current: Range[] = []) {
  if (ranges.length === 0) owners.delete(owner)
  else owners.set(owner, { ranges, current })
  paint()
}

export function clearHighlights(owner: object) {
  if (owners.delete(owner)) paint()
}

function paint() {
  // Older engines and the test DOM have no registry; matches are still counted and scrolled to.
  const registry = (CSS as { highlights?: HighlightRegistry }).highlights
  if (!registry) return
  const all = [...owners.values()]
  registry.set(MATCHES, new Highlight(...all.flatMap((entry) => entry.ranges)))
  registry.set(CURRENT, new Highlight(...all.flatMap((entry) => entry.current)))
}
