/**
 * Find-in-document for previews that render into this window: Markdown articles and PDF text
 * layers. Matches are painted with the CSS Custom Highlight API, so the document's own markup is
 * never rewritten; each owner registers its ranges and the registry repaints the union.
 */

/** The user's query and which of its matches, in document order, is the current one. */
export type FindRequest = { query: string; index: number }

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
