import type { DesktopApi } from "../contracts"

declare global {
  interface Window {
    /** The preload bridge. Absent only when the page runs outside Electron (demo mode) or when preload failed. */
    otis?: DesktopApi
  }
}
