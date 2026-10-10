import { Maximize2, X } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { IconButton } from "../../components/Button.js"
import { useI18n } from "../../i18n/index.js"
import { useDesktopSelector } from "../../runtime.js"

const canvasReloadEvent = "otis:canvas-reload"
const hot = import.meta.hot
if (hot) {
  const notifyCanvasReload = () => window.dispatchEvent(new Event(canvasReloadEvent))
  hot.on(canvasReloadEvent, notifyCanvasReload)
  hot.dispose(() => hot.off(canvasReloadEvent, notifyCanvasReload))
}

/**
 * A Mermaid diagram in the sandboxed canvas document. As a tab it fills the panel with pan and
 * zoom controls; inline, in a document, it sizes itself to the drawing and leaves scrolling to
 * the page. Either opens the diagram larger: a dialog over the window with the tab's controls,
 * where the drawing takes its full width. Theme changes repaint it in place.
 */
export function MermaidFrame({
  source,
  inline = false,
  large = false,
  onClose,
}: {
  source: string
  inline?: boolean
  large?: boolean
  /** Closes the dialog a large frame sits in; the frame asks on Escape. */
  onClose?: () => void
}) {
  const { locale, t } = useI18n()
  const theme = useDesktopSelector((state) => state?.theme)
  const frame = useRef<HTMLIFrameElement>(null)
  const [frameRevision, setFrameRevision] = useState(0)
  const [renderError, setRenderError] = useState<string>()
  const [height, setHeight] = useState<number>()
  // Opened larger: a dialog over the window, closed by its button, the backdrop, or Escape.
  // Focus moves into it as it opens, away from the frame whose button opened it, so Escape
  // reaches this window; once the drawing is clicked, its own frame answers Escape.
  const [enlarged, setEnlarged] = useState(false)
  const dialog = useRef<HTMLDivElement>(null)
  const closeDialog = useCallback(() => setEnlarged(false), [])
  useEffect(() => {
    if (!enlarged) return
    dialog.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.stopPropagation()
      setEnlarged(false)
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [enlarged])
  const closeLabel = t("canvas.closeTab", { title: t("canvas.diagram") })
  const sendSource = useCallback(() => {
    // Diagram colors come from the app theme as it is when the frame is (re)painted.
    const styles = getComputedStyle(document.documentElement)
    const color = (name: string, fallback: string) =>
      styles.getPropertyValue(name).trim() || fallback
    const colors = {
      background: color("--bg", "#1a1a1a"),
      surface: color("--bg-elev", "#262626"),
      text: color("--text", "#d8dee9"),
      muted: color("--text-dim", "#808080"),
      accent: color("--accent", "#8b7cff"),
      border: color("--border", "#444444"),
    }
    frame.current?.contentWindow?.postMessage(
      { type: "otis-canvas-source", source, inline, large, colors },
      "*",
    )
  }, [source, inline, large])
  const sendLanguage = useCallback(() => {
    frame.current?.contentWindow?.postMessage(
      {
        type: "otis-canvas-language",
        locale,
        labels: {
          viewport: t("canvas.viewport"),
          controls: t("canvas.controls"),
          zoomOut: t("canvas.zoomOut"),
          resetView: t("canvas.resetView"),
          zoomIn: t("canvas.zoomIn"),
          enlarge: t("canvas.enlarge"),
          renderFailed: t("canvas.renderFailed"),
          loadFailed: t("canvas.loadFailed"),
          emptySource: t("canvas.emptySource"),
          tooLarge: t("canvas.tooLarge"),
        },
      },
      "*",
    )
  }, [locale, t])

  useEffect(sendLanguage, [sendLanguage])
  useEffect(() => {
    setRenderError(undefined)
    sendSource()
  }, [sendSource, theme])
  useEffect(() => {
    const reload = () => setFrameRevision((revision) => revision + 1)
    window.addEventListener(canvasReloadEvent, reload)
    return () => window.removeEventListener(canvasReloadEvent, reload)
  }, [])
  // The frame reports each render; failures are announced here since the frame's own text sits
  // behind its sandbox boundary for assistive technology. It also asks to open larger, from its
  // controls, and to close again, on Escape while large.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return
      if (event.data?.type === "otis-canvas-enlarge") {
        if (event.data.open) setEnlarged(true)
        else onClose?.()
        return
      }
      if (event.data?.type !== "otis-canvas-render") return
      const message = event.data.message
      setRenderError(
        event.data.ok
          ? undefined
          : typeof message === "string"
            ? message
            : t("canvas.renderFailed"),
      )
      if (typeof event.data.height === "number") setHeight(Math.ceil(event.data.height))
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [t, onClose])

  return (
    <>
      {renderError ? (
        <div className="canvas-frameAlert" role="alert">
          {renderError}
        </div>
      ) : null}
      <iframe
        key={frameRevision}
        ref={frame}
        className={inline ? "canvas-frame canvas-frame-inline" : "canvas-frame"}
        style={inline ? { height: height ?? 160 } : undefined}
        title={t("canvas.diagram")}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        src={new URL("canvas.html", location.href).href}
        onLoad={() => {
          sendLanguage()
          sendSource()
        }}
      />
      {inline ? (
        <IconButton
          icon={Maximize2}
          label={t("canvas.enlarge")}
          size={22}
          className="md-diagramEnlarge"
          onClick={() => setEnlarged(true)}
        />
      ) : null}
      {enlarged
        ? createPortal(
            <>
              <button
                type="button"
                className="overlayBackdrop"
                aria-label={closeLabel}
                onClick={closeDialog}
              />
              <div
                ref={dialog}
                className="diagramDialog noDrag"
                role="dialog"
                aria-modal="true"
                aria-label={t("canvas.diagram")}
                tabIndex={-1}
              >
                <div className="diagramDialog-title">
                  <span>{t("canvas.diagram")}</span>
                  <IconButton icon={X} label={closeLabel} size={22} onClick={closeDialog} />
                </div>
                <MermaidFrame source={source} large onClose={closeDialog} />
              </div>
            </>,
            document.body,
          )
        : null}
    </>
  )
}
