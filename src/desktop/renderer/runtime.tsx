import { createContext, useContext } from "react"
import { useSyncExternalStoreWithSelector } from "use-sync-external-store/with-selector"
import type { DesktopApi } from "../contracts.js"
import { type DesktopViewStore, shallowEqual, type ViewState } from "./state.js"

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

/** Subscribe only to the display values this component uses. */
export function useDesktopSelector<T>(selector: (state: ViewState | undefined) => T) {
  const { store } = useDesktop()
  return useSyncExternalStoreWithSelector(store.subscribe, store.getState, undefined, selector, shallowEqual)
}

/** A field selection stays unchanged when unrelated transcript/status events arrive. */
export function useDesktopState<K extends keyof ViewState>(...keys: [K, ...K[]]): Pick<ViewState, K> | undefined {
  return useDesktopSelector((state) =>
    state ? (Object.fromEntries(keys.map((key) => [key, state[key]])) as Pick<ViewState, K>) : undefined,
  )
}
