import { spawn } from "node:child_process"
import { THIS_COMPUTER } from "../local/paths.js"

/** Where feedback goes: Otis has no service of its own to receive it. */
export const FEEDBACK_ADDRESS = "contact@triangllabs.ai"

/**
 * Opens a web page in the user's browser, or a mailto: draft in their email app, detached from
 * Otis; false when there is no launcher or it fails to start.
 */
export function openURL(url: string): Promise<boolean> {
  // On Windows, url.dll's handler is ShellExecute for a URL: its default app, no shell quoting.
  const launcher: [string, string[]] | undefined =
    process.platform === "darwin"
      ? ["/usr/bin/open", [url]]
      : process.platform === "linux"
        ? ["xdg-open", [url]]
        : process.platform === "win32"
          ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
          : undefined
  if (!launcher) return Promise.resolve(false)
  return new Promise((resolve) => {
    const child = spawn(...launcher, { detached: true, stdio: "ignore", windowsHide: true })
    child.once("error", () => resolve(false))
    child.once("spawn", () => {
      child.unref()
      resolve(true)
    })
  })
}

/**
 * A feedback email the user finishes and sends from their own email app: room to write, then the
 * Otis version, the app and this computer, which a bug report needs. Line breaks are CRLF, as
 * RFC 6068 has mailto bodies encode them.
 */
export function feedbackEmail(version: string, app: "desktop" | "terminal") {
  const about = `Otis ${version} (${app}) · ${THIS_COMPUTER.os} on ${THIS_COMPUTER.arch}`
  const body = encodeURIComponent(["", "", "", about].join("\r\n"))
  return `mailto:${FEEDBACK_ADDRESS}?subject=${encodeURIComponent("Otis feedback")}&body=${body}`
}
