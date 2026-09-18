import { app, type BrowserWindow, dialog, type WebContents } from "electron"

/** A WebContents can survive its renderer. Never send to its dead or detached main frame. */
export function sendToRenderer(contents: WebContents, channel: string, payload: unknown) {
  if (contents.isDestroyed() || contents.isCrashed()) return false
  const frame = contents.mainFrame
  if (frame.isDestroyed() || frame.detached) return false
  frame.send(channel, payload)
  return true
}

/** Recovery is user-driven: no reload loops and no implicit retry of interrupted agent work. */
export function handleRendererFailure(
  window: BrowserWindow,
  options: { onRendererGone: () => void; isQuitting: () => boolean },
) {
  let prompting = false
  const closed = () => options.isQuitting() || window.isDestroyed() || window.webContents.isDestroyed()

  async function offerReload(detail: string) {
    if (prompting || closed()) return
    prompting = true
    try {
      const { response } = await dialog.showMessageBox(window, {
        type: "error",
        message: "The Otis window stopped responding",
        detail,
        buttons: ["Reload window", "Quit"],
        defaultId: 0,
        cancelId: 1,
      })
      if (closed()) return
      if (response === 0) window.webContents.reload()
      else app.quit()
    } catch {
      if (!closed()) {
        dialog.showErrorBox(
          "Couldn't reload Otis",
          "Please reopen the app. Interrupted tasks will not restart automatically.",
        )
        app.quit()
      }
    } finally {
      prompting = false
    }
  }

  window.webContents.on("render-process-gone", (_event, details) => {
    if (closed()) return
    options.onRendererGone()
    // Only the platform's reason/exit code is included, never prompts, file contents, or credentials.
    void offerReload(
      `The UI process exited (${details.reason}, code ${details.exitCode}). Any active task was stopped. ` +
        "Reload the window to return to your session. This will not restart the task or run queued prompts.",
    )
  })
  window.webContents.on("did-fail-load", (_event, errorCode, _description, _url, isMainFrame) => {
    // ERR_ABORTED is expected when navigation is superseded. Subframe failures must not interrupt the agent.
    if (!isMainFrame || errorCode === -3 || closed()) return
    options.onRendererGone()
    void offerReload(
      `The window could not load (code ${errorCode}). If this is Otis Dev, check that the dev server is still running. ` +
        "Reloading will not restart interrupted tasks.",
    )
  })
}
