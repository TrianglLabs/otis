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

export function PdfPreview({ source }: { source: string }) {
  const { t } = useI18n()
  const [document, setDocument] = useState<PDFDocumentProxy>()
  const [error, setError] = useState<string>()
  const [scroller, setScroller] = useState<HTMLElement | null>(null)
  const scrollerRef = useCallback((element: HTMLElement | Window | null) => {
    setScroller(element instanceof HTMLElement ? element : null)
  }, [])
  const [width, setWidth] = useState(0)

  useEffect(() => {
    let current = true
    let loading: PDFDocumentLoadingTask | undefined
    let worker: PDFWorker | undefined
    let port: Worker | undefined
    setDocument(undefined)
    setError(undefined)
    void (async () => {
      const pdf = await import("pdfjs-dist/legacy/build/pdf.mjs")
      if (!current) return
      port = new PdfWorker()
      worker = pdf.PDFWorker.create({ port })
      const decoded = atob(source)
      const data = new Uint8Array(decoded.length)
      for (let index = 0; index < decoded.length; index += 1)
        data[index] = decoded.charCodeAt(index)
      loading = pdf.getDocument({ data, useSystemFonts: true, worker })
      const loaded = await loading.promise
      if (current) setDocument(loaded)
    })().catch((reason: unknown) => {
      if (current) setError(reason instanceof Error ? reason.message : t("canvas.previewFailed"))
    })
    return () => {
      current = false
      // Let PDF.js finish its transport shutdown before terminating the worker it communicates
      // with.
      void (async () => {
        try {
          await loading?.destroy()
        } finally {
          worker?.destroy()
          port?.terminate()
        }
      })().catch((reason: unknown) => console.error("Could not release PDF preview", reason))
    }
  }, [source, t])

  useEffect(() => {
    if (!scroller) return
    // Use the scrollable content width, excluding any non-overlay scrollbar.
    const measure = () => setWidth(Math.max(0, scroller.clientWidth - 32))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [scroller])

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
        totalCount={width > 0 ? document.numPages : 0}
        increaseViewportBy={200}
        components={{ Header: PdfPageInset }}
        itemContent={(index) => (
          <PdfPageView document={document} pageNumber={index + 1} width={width} />
        )}
      />
    </div>
  )
}

function PdfPageInset() {
  return <div className="canvas-pdfInset" />
}

function PdfPageView({
  document,
  pageNumber,
  width,
}: {
  document: PDFDocumentProxy
  pageNumber: number
  width: number
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
    <div className="canvas-pdfItem" style={{ height: width / aspectRatio + 16 }}>
      {error ? (
        <div className="canvas-pdfError" role="alert">
          {error}
        </div>
      ) : null}
      <canvas
        ref={canvas}
        className="canvas-pdfPage"
        style={{ width, height: width / aspectRatio }}
        aria-label={t("canvas.page", { number: pageNumber })}
        hidden={!!error}
      />
    </div>
  )
}
