import { useCallback, useEffect, useRef, useState } from "react"
import type { ThemeName } from "../../../contracts.js"
import type { CanvasArtifact } from "./canvas-context.js"

const canvasReloadEvent = "otis:canvas-reload"
const hot = import.meta.hot
if (hot) {
  const notifyCanvasReload = () => window.dispatchEvent(new Event(canvasReloadEvent))
  hot.on(canvasReloadEvent, notifyCanvasReload)
  hot.dispose(() => hot.off(canvasReloadEvent, notifyCanvasReload))
}

export function CanvasPanel({ artifact, theme }: { artifact: CanvasArtifact | undefined; theme: ThemeName }) {
  if (!artifact) return <div className="canvas-empty">Open a Mermaid block to use Canvas.</div>
  return <MermaidFrame source={artifact.source} theme={theme} />
}

function MermaidFrame({ source, theme }: { source: string; theme: ThemeName }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [frameRevision, setFrameRevision] = useState(0)
  const sendSource = useCallback(() => {
    frame.current?.contentWindow?.postMessage({ type: "otis-canvas-source", source, colors: canvasColors() }, "*")
  }, [source])

  useEffect(() => {
    sendSource()
  }, [sendSource, theme])

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
      title="Canvas diagram"
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      src={new URL("canvas.html", location.href).href}
      onLoad={sendSource}
    />
  )
}

function canvasColors() {
  const styles = getComputedStyle(document.documentElement)
  return {
    background: cssColor(styles, "--bg", "#1a1a1a"),
    surface: cssColor(styles, "--bg-elev", "#262626"),
    text: cssColor(styles, "--text", "#d8dee9"),
    muted: cssColor(styles, "--text-dim", "#808080"),
    accent: cssColor(styles, "--accent", "#8b7cff"),
    border: cssColor(styles, "--border", "#444444"),
  }
}

function cssColor(styles: CSSStyleDeclaration, name: string, fallback: string) {
  return styles.getPropertyValue(name).trim() || fallback
}
