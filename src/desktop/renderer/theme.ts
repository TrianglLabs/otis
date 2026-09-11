/**
 * Boot-time theme. The workspace theme arrives with the first snapshot — after the boot screen — so the theme
 * applied last session is remembered here and restored before the first paint, letting the boot screen render
 * in the user's theme. An unrecognized stored value matches no [data-theme] rule and falls back to the default
 * tokens, so no validation against the theme list is needed.
 *
 * Storage can be missing (minimal DOMs) or fail (locked-down contexts); theme memory is best-effort and must
 * never block rendering.
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
