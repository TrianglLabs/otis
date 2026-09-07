import { createContext, useContext, useSyncExternalStore } from "react"
import type { DesktopApi } from "../contracts.js"
import type { DesktopViewStore, ViewState } from "./state.js"

export type DesktopContextValue = { api: DesktopApi; store: DesktopViewStore }

const DesktopContext = createContext<DesktopContextValue | null>(null)

export function DesktopProvider({ value, children }: { value: DesktopContextValue; children: React.ReactNode }) {
  return <DesktopContext.Provider value={value}>{children}</DesktopContext.Provider>
}

export function useDesktop(): DesktopContextValue {
  const value = useContext(DesktopContext)
  if (!value) throw new Error("useDesktop must be used within DesktopProvider")
  return value
}

/** The application display copy. Undefined until the initial snapshot arrives. */
export function useDesktopState(): ViewState | undefined {
  const { store } = useDesktop()
  return useSyncExternalStore(store.subscribe, store.getState, () => undefined)
}
