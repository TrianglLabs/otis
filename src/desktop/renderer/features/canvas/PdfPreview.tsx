import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  PDFWorker,
  RenderTask,
  TextLayer,
} from "pdfjs-dist/legacy/build/pdf.mjs"
import PdfWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs?worker"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso"
import { useI18n } from "../../i18n/index.js"
import { clearHighlights, type FindRequest, matchOffsets, setHighlights } from "./find.js"

type PdfSession = { loading: PDFDocumentLoadingTask; worker: PDFWorker; port: Worker }
type Pdf = typeof import("pdfjs-dist/legacy/build/pdf.mjs")
/** A page's text as one string, with where each text run starts, so matches map back to runs. */
type PageText = { text: string; starts: number[] }
type PageMatch = { page: number; start: number; end: number }

/** Pages re-render only once the panel width has settled; meanwhile the bitmaps scale in CSS. */
const RENDER_WIDTH_SETTLE_MS = 120
/** Match counts refresh this often while a long document's text is still being read. */
const MATCH_REPORT_PAGES = 8
const NO_MATCHES: PageMatch[] = []

/**
 * Pages are bitmaps under a PDF.js text layer, so text selects, copies, and is searchable. `zoom`
 * scales the fit-to-width size; `find` highlights every match and scrolls to the current one,
 * reporting the count through `onMatches`.
 */
export function PdfPreview({
  data,
  zoom = 1,
  find,
  onMatches,
}: {
  data: Uint8Array
  zoom?: number
  find?: FindRequest
  onMatches?: (count: number) => void
}) {
  const { t } = useI18n()
  const [document, setDocument] = useState<{ pdf: Pdf; proxy: PDFDocumentProxy }>()
  const [error, setError] = useState<string>()
  const [scroller, setScroller] = useState<HTMLElement | null>(null)
  const scrollerRef = useCallback((element: HTMLElement | Window | null) => {
    setScroller(element instanceof HTMLElement ? element : null)
  }, [])
  const list = useRef<VirtuosoHandle>(null)
  const [fitWidth, setFitWidth] = useState(0)
  const width = Math.round(fitWidth * zoom)
  const [renderWidth, setRenderWidth] = useState(0)
  // The transport behind the displayed document; it outlives a data change until the replacement
  // has loaded, so existing pages never lose their document mid-render.
  const shown = useRef<PdfSession>(undefined)
  const texts = useRef(new Map<number, Promise<PageText>>())
  const [matches, setMatches] = useState<PageMatch[]>([])

  useEffect(() => {
    let current = true
    let pending: PdfSession | undefined
    void (async () => {
      const pdf = await import("pdfjs-dist/legacy/build/pdf.mjs")
      if (!current) return
      const port = new PdfWorker()
      const worker = pdf.PDFWorker.create({ port })
      // PDF.js transfers the buffer it is given; keep the payload intact for later reloads.
      const loading = pdf.getDocument({ data: data.slice(), useSystemFonts: true, worker })
      pending = { loading, worker, port }
      const loaded = await loading.promise
      if (!current) return
      const previous = shown.current
      shown.current = pending
      pending = undefined
      texts.current = new Map()
      setDocument({ pdf, proxy: loaded })
      setError(undefined)
      if (previous) release(previous)
    })().catch((reason: unknown) => {
      if (!current) return
      setError(reason instanceof Error ? reason.message : t("canvas.previewFailed"))
      if (pending) release(pending)
      pending = undefined
    })
    return () => {
      current = false
      if (pending) release(pending)
    }
  }, [data])
  useEffect(
    () => () => {
      if (shown.current) release(shown.current)
    },
    [],
  )

  useEffect(() => {
    if (!scroller) return
    // Use the scrollable content width, excluding any non-overlay scrollbar.
    const measure = () => setFitWidth(Math.max(0, scroller.clientWidth - 32))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [scroller])

  useEffect(() => {
    if (width === renderWidth) return
    if (renderWidth === 0) {
      setRenderWidth(width)
      return
    }
    const timer = setTimeout(() => setRenderWidth(width), RENDER_WIDTH_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [width, renderWidth])

  // Pages are read in order and the running count reported, so a long document answers early.
  const query = find?.query ?? ""
  useEffect(() => {
    if (!document || !query) {
      setMatches([])
      onMatches?.(0)
      return
    }
    let current = true
    const found: PageMatch[] = []
    const report = () => {
      setMatches([...found])
      onMatches?.(found.length)
    }
    void (async () => {
      for (let page = 1; page <= document.proxy.numPages && current; page += 1) {
        // A page's runs joined as PDF.js's find does: nothing between runs, a newline at each EOL.
        let pending = texts.current.get(page)
        if (!pending) {
          pending = document.proxy.getPage(page).then(async (proxy) => {
            const content = await proxy.getTextContent()
            const starts: number[] = []
            let text = ""
            for (const item of content.items) {
              if (!("str" in item)) continue
              starts.push(text.length)
              text += item.str
              if (item.hasEOL) text += "\n"
            }
            return { text, starts }
          })
          texts.current.set(page, pending)
        }
        const { text } = await pending
        if (!current) return
        for (const start of matchOffsets(text, query))
          found.push({ page, start, end: start + query.length })
        if (page % MATCH_REPORT_PAGES === 0) report()
      }
      if (current) report()
    })().catch((reason: unknown) => console.error("Could not search the PDF", reason))
    return () => {
      current = false
    }
  }, [document, query])
  const currentMatch = matches[find?.index ?? -1]
  // One array per page, stable across renders, so a page's highlights settle once per search.
  const matchesByPage = useMemo(() => {
    const byPage = new Map<number, PageMatch[]>()
    for (const match of matches) byPage.set(match.page, [...(byPage.get(match.page) ?? []), match])
    return byPage
  }, [matches])
  useEffect(() => {
    if (currentMatch) list.current?.scrollToIndex({ index: currentMatch.page - 1, align: "start" })
  }, [currentMatch])

  if (error)
    return (
      <div className="canvas-empty" role="alert">
        {error}
      </div>
    )
  if (!document) return <div className="canvas-empty">{t("canvas.loading")}</div>
  return (
    <div className="canvas-pdf">
      <Virtuoso
        ref={list}
        className="canvas-pdfPages"
        scrollerRef={scrollerRef}
        totalCount={renderWidth > 0 ? document.proxy.numPages : 0}
        increaseViewportBy={200}
        components={{ Header: PdfPageInset }}
        itemContent={(index) => (
          <PdfPageView
            pdf={document.pdf}
            document={document.proxy}
            pageNumber={index + 1}
            width={renderWidth}
            displayWidth={width}
            texts={texts.current}
            matches={matchesByPage.get(index + 1) ?? NO_MATCHES}
            current={currentMatch?.page === index + 1 ? currentMatch : undefined}
          />
        )}
      />
    </div>
  )
}

function release(session: PdfSession) {
  // Let PDF.js finish its transport shutdown before terminating the worker it communicates with.
  void (async () => {
    try {
      await session.loading.destroy()
    } finally {
      session.worker.destroy()
      session.port.terminate()
    }
  })().catch((reason: unknown) => console.error("Could not release PDF preview", reason))
}

function PdfPageInset() {
  return <div className="canvas-pdfInset" />
}

function PdfPageView({
  pdf,
  document,
  pageNumber,
  width,
  displayWidth,
  texts,
  matches,
  current,
}: {
  pdf: Pdf
  document: PDFDocumentProxy
  pageNumber: number
  width: number
  displayWidth: number
  texts: Map<number, Promise<PageText>>
  matches: PageMatch[]
  current: PageMatch | undefined
}) {
  const { t } = useI18n()
  const canvas = useRef<HTMLCanvasElement>(null)
  const textContainer = useRef<HTMLDivElement>(null)
  const textLayer = useRef<TextLayer>(undefined)
  const [textReady, setTextReady] = useState(0)
  const [aspectRatio, setAspectRatio] = useState(612 / 792)
  const [error, setError] = useState<string>()
  useEffect(() => {
    const target = canvas.current
    const container = textContainer.current
    if (!target || !container || width <= 0) return
    let current = true
    let render: RenderTask | undefined
    let page: PDFPageProxy | undefined
    setError(undefined)
    void (async () => {
      page = await document.getPage(pageNumber)
      if (!current) return
      const natural = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: width / natural.width })
      setAspectRatio(natural.width / natural.height)
      const context = target.getContext("2d")
      if (!context) throw new Error(t("canvas.previewFailed"))
      // Bound backing pixels even for unusually tall pages or high-density displays.
      const ratio = Math.min(
        window.devicePixelRatio || 1,
        2,
        Math.sqrt(8_000_000 / (viewport.width * viewport.height)),
        16_384 / Math.max(viewport.width, viewport.height),
      )
      target.width = Math.max(1, Math.floor(viewport.width * ratio))
      target.height = Math.max(1, Math.floor(viewport.height * ratio))
      render = page.render({
        canvas: target,
        canvasContext: context,
        viewport,
        transform: [ratio, 0, 0, ratio, 0, 0],
      })
      // The text layer lays out in CSS pixels; PDF.js scales its runs by this factor.
      container.style.setProperty("--total-scale-factor", String(viewport.scale * page.userUnit))
      const layer = new pdf.TextLayer({
        textContentSource: page.streamTextContent(),
        container,
        viewport,
      })
      textLayer.current = layer
      await Promise.all([render.promise, layer.render()])
      if (current) setTextReady((ready) => ready + 1)
    })()
      .catch((reason: unknown) => {
        if (current) setError(reason instanceof Error ? reason.message : t("canvas.previewFailed"))
      })
      .finally(() => page?.cleanup())
    return () => {
      current = false
      render?.cancel()
      textLayer.current?.cancel()
      textLayer.current = undefined
      container.replaceChildren()
      target.width = 0
      target.height = 0
    }
  }, [pdf, document, pageNumber, width, t])

  // Matches map from page-text offsets to the text layer's runs once both exist.
  useEffect(() => {
    const layer = textLayer.current
    const owner = textContainer.current
    if (!owner || !layer || textReady === 0 || matches.length === 0) return
    let live = true
    void texts.get(pageNumber)?.then(({ starts }) => {
      if (!live) return
      const rangesOf = (match: PageMatch) => {
        const ranges: Range[] = []
        for (let run = 0; run < starts.length; run += 1) {
          const next = starts[run + 1] ?? Number.POSITIVE_INFINITY
          const node = layer.textDivs[run]?.firstChild
          if (!(node instanceof Text) || next <= match.start || starts[run] >= match.end) continue
          const range = new Range()
          range.setStart(node, Math.min(node.length, Math.max(0, match.start - starts[run])))
          range.setEnd(node, Math.min(node.length, match.end - starts[run]))
          ranges.push(range)
        }
        return ranges
      }
      const active = current ? rangesOf(current) : []
      setHighlights(owner, matches.flatMap(rangesOf), active)
      active[0]?.startContainer.parentElement?.scrollIntoView({ block: "center" })
    })
    return () => {
      live = false
      clearHighlights(owner)
    }
  }, [texts, pageNumber, textReady, matches, current])

  const height = displayWidth / aspectRatio
  return (
    <div className="canvas-pdfItem" style={{ width: displayWidth + 32, height: height + 16 }}>
      {error ? (
        <div className="canvas-pdfError" role="alert">
          {error}
        </div>
      ) : null}
      <div
        className="canvas-pdfSurface"
        style={{
          width,
          height: width / aspectRatio,
          transform: `scale(${width > 0 ? displayWidth / width : 1})`,
        }}
        hidden={!!error}
      >
        <canvas
          ref={canvas}
          className="canvas-pdfPage"
          style={{ width, height: width / aspectRatio }}
          aria-label={t("canvas.page", { number: pageNumber })}
        />
        <div ref={textContainer} className="textLayer" />
      </div>
    </div>
  )
}
