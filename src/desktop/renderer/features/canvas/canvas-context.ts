import { createContext, useContext } from "react"

export type CanvasArtifact = {
  id: number
  source: string
}

export const CanvasOpenContext = createContext<((source: string) => void) | undefined>(undefined)

export function useOpenCanvas() {
  return useContext(CanvasOpenContext)
}
