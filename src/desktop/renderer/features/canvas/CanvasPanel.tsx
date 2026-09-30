import { useI18n } from "../../i18n/index.js"
import type { CanvasView } from "./canvas-context.js"
import { FileArtifact } from "./FileArtifact.js"
import { MermaidFrame } from "./MermaidFrame.js"

export function CanvasPanel({ view }: { view: CanvasView | undefined }) {
  const { t } = useI18n()
  if (!view) return <div className="canvas-empty">{t("canvas.empty")}</div>
  // Keyed per document: zoom and find state belong to one file, not to the panel.
  if (view.runtime !== undefined)
    return <FileArtifact key={view.key} runtime={view.runtime} artifact={view.artifact} />
  return <MermaidFrame source={view.artifact.source} />
}
