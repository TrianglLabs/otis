import { useCallback, useEffect, useRef, useState } from "react"
import type { ThemeName } from "../../../contracts.js"
import { useI18n } from "../../i18n/index.js"
import type { CanvasArtifact } from "./canvas-context.js"
import { FileArtifact } from "./FileArtifact.js"

const canvasReloadEvent = "otis:canvas-reload"
const hot = import.meta.hot
if (hot) {
  const notifyCanvasReload = () => window.dispatchEvent(new Event(canvasReloadEvent))
  hot.on(canvasReloadEvent, notifyCanvasReload)
  hot.dispose(() => hot.off(canvasReloadEvent, notifyCanvasReload))
}

export function CanvasPanel({
  artifact,
  theme,
}: {
  artifact: CanvasArtifact | undefined
  theme: ThemeName
}) {
  const { t } = useI18n()
  if (!artifact) return <div className="canvas-empty">{t("canvas.empty")}</div>
  if (artifact.kind !== "mermaid") return <FileArtifact artifact={artifact} />
  return <MermaidFrame source={artifact.source} theme={theme} />
}

function MermaidFrame({ source, theme }: { source: string; theme: ThemeName }) {
  const { locale, t } = useI18n()
  const frame = useRef<HTMLIFrameElement>(null)
  const [frameRevision, setFrameRevision] = useState(0)
  const sendSource = useCallback(() => {
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
    frame.current?.contentWindow?.postMessage({ type: "otis-canvas-source", source, colors }, "*")
  }, [source])
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
  useEffect(() => sendSource(), [sendSource, theme])
  useEffect(() => {
    const reload = () => setFrameRevision((revision) => revision + 1)
    window.addEventListener(canvasReloadEvent, reload)
    return () => window.removeEventListener(canvasReloadEvent, reload)
  }, [])

  return (
    <iframe
      key={frameRevision}
      ref={frame}
      className="canvas-frame"
      title={t("canvas.diagram")}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      src={new URL("canvas.html", location.href).href}
      onLoad={() => {
        sendLanguage()
        sendSource()
      }}
    />
  )
}
