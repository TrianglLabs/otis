import { createContext, useContext } from "react"
import type { ArtifactMetadata } from "../../../../artifacts/types.js"

export type MermaidCanvasArtifact = {
  kind: "mermaid"
  id: number
  source: string
}

export type CanvasArtifact = MermaidCanvasArtifact | ArtifactMetadata

export const CanvasOpenContext = createContext<((source: string) => void) | undefined>(undefined)

export function canvasArtifactKey(artifact: CanvasArtifact | undefined) {
  if (!artifact) return undefined
  return artifact.kind === "mermaid" ? `mermaid:${artifact.id}` : `${artifact.id}:${artifact.revision}`
}

export function useOpenCanvas() {
  return useContext(CanvasOpenContext)
}
