import { createContext, useContext, useEffect, useRef, useState } from "react"
import { useSyncExternalStoreWithSelector } from "use-sync-external-store/with-selector"
import type { DesktopApi } from "../contracts.js"
import { type DesktopViewStore, shallowEqual, type ViewState } from "./state.js"

type DesktopContextValue = { api: DesktopApi; store: DesktopViewStore }

const DesktopContext = createContext<DesktopContextValue | null>(null)

export function DesktopProvider({
  value,
  children,
}: {
  value: DesktopContextValue
  children: React.ReactNode
}) {
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
  return useSyncExternalStoreWithSelector(
    store.subscribe,
    store.getState,
    undefined,
    selector,
    shallowEqual,
  )
}

/** A field selection stays unchanged when unrelated transcript/status events arrive. */
export function useDesktopState<K extends keyof ViewState>(
  ...keys: [K, ...K[]]
): Pick<ViewState, K> | undefined {
  return useDesktopSelector((state) =>
    state
      ? (Object.fromEntries(keys.map((key) => [key, state[key]])) as Pick<ViewState, K>)
      : undefined,
  )
}

/**
 * Shows the scrollbar while the element is being scrolled and briefly after, matching macOS
 * overlay-scrollbar behavior for the custom thin scrollbars. Returns the class flag and the handler
 * to attach to the scrollable.
 */
export function useScrollbarFlash() {
  const [scrolling, setScrolling] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(timer.current), [])

  const onScroll = () => {
    setScrolling(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setScrolling(false), 700)
  }

  return { scrolling, onScroll }
}

/**
 * Boot-time theme. The workspace theme arrives with the first snapshot — after the boot screen — so
 * the theme applied last session is remembered here and restored before the first paint, letting
 * the boot screen render in the user's theme. An unrecognized stored value matches no [data-theme]
 * rule and falls back to the default tokens, so no validation against the theme list is needed.
 *
 * Storage can be missing (minimal DOMs) or fail (locked-down contexts); theme memory is best-effort
 * and must never block rendering.
 */
const THEME_STORAGE_KEY = "otis.theme"

export function applyStoredTheme() {
  try {
    const theme = globalThis.localStorage?.getItem(THEME_STORAGE_KEY)
    if (theme) document.documentElement.dataset.theme = theme
  } catch {
    // Best-effort: boot falls back to the default theme.
  }
}

export function rememberTheme(theme: string) {
  try {
    globalThis.localStorage?.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // Best-effort: the theme still applies to this session.
  }
}
