import { randomUUID } from "node:crypto"
import { rename, rm, writeFile } from "node:fs/promises"
import { dirname, extname, join } from "node:path"
import { BrowserWindow, dialog, type IpcMainInvokeEvent, ipcMain, shell } from "electron"
import { describeError } from "../../inference/errors.js"
import { HOSTED_PROVIDER_INFO, isHostedProvider } from "../../inference/types.js"
import { DESKTOP_CHANNELS, type SessionOpResult } from "../contracts.js"
import type { DesktopBackend } from "./api.js"

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

/**
 * Registers the IPC handlers for the desktop API. Every handler checks that the call comes from our
 * own renderer; payloads are validated where the runtime lives, by `desktopCall`. `actions` are
 * what the window asks of this process rather than of the runtime serving it.
 */
export function registerDesktopIpc(
  backend: DesktopBackend,
  actions: {
    connectRemote(url: string, token: string): Promise<SessionOpResult>
    disconnectRemote(): Promise<void>
  },
) {
  const window = (event: IpcMainInvokeEvent) =>
    BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getAllWindows()[0]
  const local: Record<string, Handler> = {
    // Saves the captured revision only to a destination chosen through the native Save dialog.
    saveArtifact: async (
      event: IpcMainInvokeEvent,
      target: unknown,
      id: unknown,
      revision: unknown,
    ): Promise<SessionOpResult> => {
      const file = (await backend.call("getArtifactFile", [target, id, revision])) as
        | { name: string; bytes: Uint8Array }
        | undefined
      if (!file)
        return { ok: false, reason: "This preview changed. Try saving the current version again." }
      try {
        const extension = extname(file.name)
        const result = await dialog.showSaveDialog(window(event), {
          defaultPath: file.name,
          filters: [{ name: extension.slice(1).toUpperCase(), extensions: [extension.slice(1)] }],
          properties: ["showOverwriteConfirmation", "createDirectory"],
        })
        if (result.canceled || !result.filePath) return { ok: true }
        const path = result.filePath
        if (extname(path).toLowerCase() !== extension.toLowerCase())
          throw new Error(
            `Keep the ${extension} extension. Saving a copy does not convert the file.`,
          )
        const temporary = join(dirname(path), `.otis-export-${randomUUID()}.tmp`)
        try {
          await writeFile(temporary, file.bytes, { flag: "wx", mode: 0o600 })
          await rename(temporary, path)
        } finally {
          await rm(temporary, { force: true })
        }
        return { ok: true }
      } catch (error) {
        return { ok: false, reason: describeError(error) }
      }
    },
    getWindowState: (event: IpcMainInvokeEvent) => ({
      fullscreen: window(event)?.isFullScreen() ?? false,
    }),
    pickWorkspaceFolder: async (event: IpcMainInvokeEvent) => {
      const result = await dialog.showOpenDialog(window(event), {
        title: "Open Folder",
        properties: ["openDirectory", "createDirectory"],
      })
      return result.canceled ? undefined : result.filePaths[0]
    },
    // The CLI spawns open/xdg-open for the same provider pages; the desktop main uses Electron's
    // shell.
    openHostedKeyPage: (_event: IpcMainInvokeEvent, provider: unknown) => {
      if (!isHostedProvider(provider)) throw new Error("Invalid hosted provider.")
      return shell.openExternal(HOSTED_PROVIDER_INFO[provider].keyURL)
    },
    connectRemote: (_event: IpcMainInvokeEvent, url: unknown, token: unknown) => {
      if (typeof url !== "string" || typeof token !== "string")
        throw new Error("connectRemote expects an address and a token")
      return actions.connectRemote(url.trim(), token.trim())
    },
    disconnectRemote: () => actions.disconnectRemote(),
  }
  const pushed: string[] = [
    DESKTOP_CHANNELS.event,
    DESKTOP_CHANNELS.terminal,
    DESKTOP_CHANNELS.windowState,
  ]
  for (const [method, channel] of Object.entries(DESKTOP_CHANNELS)) {
    if (pushed.includes(channel)) continue
    const handler: Handler = local[method] ?? ((_event, ...args) => backend.call(method, args))
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      assertTrustedSender(event)
      // A rejection reaches the renderer as the sentence it should show.
      try {
        return await handler(event, ...args)
      } catch (error) {
        throw new Error(describeError(error))
      }
    })
  }
}

/** Only our own renderer may invoke the desktop API. */
function assertTrustedSender(event: IpcMainInvokeEvent) {
  const url = event.senderFrame?.url ?? ""
  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  try {
    const parsed = new URL(url)
    if (devServerUrl) {
      if (url.startsWith(devServerUrl)) return
    } else if (parsed.protocol === "file:" && parsed.pathname.endsWith("/index.html")) {
      return
    }
  } catch {
    // Malformed sender URL: fall through to rejection.
  }
  throw new Error(`Rejected desktop IPC from untrusted sender: ${url || "unknown"}`)
}
