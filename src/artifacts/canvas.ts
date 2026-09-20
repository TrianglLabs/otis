import type { ArtifactKind } from "./types.js"

/** Canvas shows rendered documents and visuals. Plain text and code stay in the conversation. */
export function isCanvasArtifact(kind: ArtifactKind) {
  return kind === "markdown" || kind === "html" || kind === "pdf" || kind === "docx"
}
