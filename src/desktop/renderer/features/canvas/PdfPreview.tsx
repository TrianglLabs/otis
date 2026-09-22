import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  PDFWorker,
  RenderTask,
} from "pdfjs-dist/legacy/build/pdf.mjs"
import PdfWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs?worker"
import { useCallback, useEffect, useRef, useState } from "react"
import { Virtuoso } from "react-virtuoso"
import { useI18n } from "../../i18n/index.js"

type PdfSession = { loading: PDFDocumentLoadingTask; worker: PDFWorker; port: Worker }

/** Pages re-render only once the panel width has settled; meanwhile the bitmaps scale in CSS. */
const RENDER_WIDTH_SETTLE_MS = 120

export function PdfPreview({ data }: { data: Uint8Array }) {
  const { t } = useI18n()
  const [document, setDocument] = useState<PDFDocumentProxy>()
  const [error, setError] = useState<string>()
  const [scroller, setScroller] = useState<HTMLElement | null>(null)
  const scrollerRef = useCallback((element: HTMLElement | Window | null) => {
    setScroller(element instanceof HTMLElement ? element : null)
  }, [])
  const [width, setWidth] = useState(0)
  const [renderWidth, setRenderWidth] = useState(0)
  // The transport behind the displayed document; it outlives a data change until the replacement
  // has loaded, so existing pages never lose their document mid-render.
  const shown = useRef<PdfSession>(undefined)

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
      setDocument(loaded)
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
    const measure = () => setWidth(Math.max(0, scroller.clientWidth - 32))
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
        className="canvas-pdfPages"
        scrollerRef={scrollerRef}
        totalCount={renderWidth > 0 ? document.numPages : 0}
        increaseViewportBy={200}
        components={{ Header: PdfPageInset }}
        itemContent={(index) => (
          <PdfPageView
            document={document}
            pageNumber={index + 1}
            width={renderWidth}
            displayWidth={width}
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
  document,
  pageNumber,
  width,
  displayWidth,
}: {
  document: PDFDocumentProxy
  pageNumber: number
  width: number
  displayWidth: number
}) {
  const { t } = useI18n()
  const canvas = useRef<HTMLCanvasElement>(null)
  const [aspectRatio, setAspectRatio] = useState(612 / 792)
  const [error, setError] = useState<string>()
  useEffect(() => {
    const target = canvas.current
    if (!target || width <= 0) return
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
      await render.promise
    })()
      .catch((reason: unknown) => {
        if (current) setError(reason instanceof Error ? reason.message : t("canvas.previewFailed"))
      })
      .finally(() => page?.cleanup())
    return () => {
      current = false
      render?.cancel()
      target.width = 0
      target.height = 0
    }
  }, [document, pageNumber, width, t])
  return (
    <div className="canvas-pdfItem" style={{ height: displayWidth / aspectRatio + 16 }}>
      {error ? (
        <div className="canvas-pdfError" role="alert">
          {error}
        </div>
      ) : null}
      <canvas
        ref={canvas}
        className="canvas-pdfPage"
        style={{ width: displayWidth, height: displayWidth / aspectRatio }}
        aria-label={t("canvas.page", { number: pageNumber })}
        hidden={!!error}
      />
    </div>
  )
}
