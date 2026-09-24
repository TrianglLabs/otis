import { createContext, useContext } from "react"
import type { ArtifactMetadata } from "../../../../artifacts/types.js"

type MermaidCanvasArtifact = {
  kind: "mermaid"
  id: number
  source: string
}

export type CanvasArtifact = MermaidCanvasArtifact | ArtifactMetadata

/**
 * One Canvas tab as the panel lists it: a session's open document, or the diagram opened from a
 * card, which belongs to the renderer alone. `activated` orders tabs by when they last took the
 * view, across sessions and the diagram alike.
 */
export type CanvasView = { key: string; activated: number } & (
  | { runtime: number; artifact: ArtifactMetadata }
  | { runtime?: undefined; artifact: MermaidCanvasArtifact }
)

export const CanvasOpenContext = createContext<((source: string) => void) | undefined>(undefined)

/** The session whose Canvas tab a card in this pane opens; undefined is the focused session. */
export const PaneRuntimeContext = createContext<number | undefined>(undefined)

export function useOpenCanvas() {
  return useContext(CanvasOpenContext)
}
