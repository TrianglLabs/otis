import { randomUUID } from "node:crypto"
import { rename, rm, writeFile } from "node:fs/promises"
import { dirname, extname, join } from "node:path"
import { BrowserWindow, dialog, type IpcMainInvokeEvent, ipcMain, shell } from "electron"
import { isArtifactReference } from "../../artifacts/types.js"
import {
  DESKTOP_CHANNELS,
  type DesktopAttachmentInput,
  type SessionOpResult,
} from "../contracts.js"
import type { DesktopRuntime } from "./runtime.js"

/**
 * Registers the validated IPC handlers for the desktop API. Every handler checks that the call
 * comes from our own renderer before touching the runtime, and validates payload shapes at the
 * boundary.
 */
export function registerDesktopIpc(runtime: DesktopRuntime) {
  handle(DESKTOP_CHANNELS.getSnapshot, () => runtime.snapshot())
  handle(DESKTOP_CHANNELS.getArtifact, (target, id, revision) => {
    if (typeof target !== "number") throw new Error("getArtifact expects a numeric runtime id")
    if (typeof id !== "string" || !id) throw new Error("getArtifact expects an artifact id")
    if (typeof revision !== "number") throw new Error("getArtifact expects a numeric revision")
    return runtime.getArtifact(target, id, revision)
  })
  handle(DESKTOP_CHANNELS.openArtifact, (reference, version, target) => {
    if (!isArtifactReference(reference))
      throw new Error("openArtifact expects a valid artifact reference")
    if (
      version !== undefined &&
      (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1)
    )
      throw new Error("openArtifact expects a positive integer version")
    if (target !== undefined && typeof target !== "number")
      throw new Error("openArtifact expects a numeric runtime id")
    return runtime.openArtifact(reference, version, target)
  })
  handle(DESKTOP_CHANNELS.closeArtifact, (target, id) => {
    if (typeof target !== "number") throw new Error("closeArtifact expects a numeric runtime id")
    if (typeof id !== "string" || !id) throw new Error("closeArtifact expects an artifact id")
    runtime.closeArtifact(target, id)
  })

  // Saves the captured revision only to a destination chosen through the native Save dialog.
  ipcMain.handle(
    DESKTOP_CHANNELS.saveArtifact,
    async (
      event: IpcMainInvokeEvent,
      target: unknown,
      id: unknown,
      revision: unknown,
    ): Promise<SessionOpResult> => {
      assertTrustedSender(event)
      if (typeof target !== "number") throw new Error("saveArtifact expects a numeric runtime id")
      if (typeof id !== "string" || !id) throw new Error("saveArtifact expects an artifact id")
      if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)
        throw new Error("saveArtifact expects a numeric revision")
      const file = await runtime.getArtifactFile(target, id, revision)
      if (!file)
        return { ok: false, reason: "This preview changed. Try saving the current version again." }
      try {
        const extension = extname(file.name)
        const result = await dialog.showSaveDialog(
          BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getAllWindows()[0],
          {
            defaultPath: file.name,
            filters: [{ name: extension.slice(1).toUpperCase(), extensions: [extension.slice(1)] }],
            properties: ["showOverwriteConfirmation", "createDirectory"],
          },
        )
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
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  ipcMain.handle(DESKTOP_CHANNELS.getWindowState, (event: IpcMainInvokeEvent) => {
    assertTrustedSender(event)
    return { fullscreen: BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false }
  })

  handle(DESKTOP_CHANNELS.sendPrompt, (text, attachments) => {
    if (typeof text !== "string") throw new Error("sendPrompt expects a string")
    const valid =
      attachments === undefined ||
      (Array.isArray(attachments) &&
        attachments.every(
          (attachment): attachment is DesktopAttachmentInput =>
            typeof attachment === "object" &&
            attachment !== null &&
            typeof attachment.name === "string" &&
            typeof attachment.mimeType === "string" &&
            attachment.bytes instanceof Uint8Array,
        ))
    if (!valid) throw new Error("sendPrompt expects valid attachments")
    return runtime.sendPrompt(text, attachments)
  })

  handle(DESKTOP_CHANNELS.stop, () => runtime.stop())

  handle(DESKTOP_CHANNELS.respondToPermission, (id, allow) => {
    if (typeof id !== "number" || typeof allow !== "boolean") {
      throw new Error("respondToPermission expects a numeric id and a boolean decision")
    }
    runtime.respondToPermission(id, allow)
  })

  handle(DESKTOP_CHANNELS.selectSession, (id, dirName) => {
    if (typeof id !== "string") throw new Error("selectSession expects a string id")
    if (dirName !== undefined && typeof dirName !== "string")
      throw new Error("selectSession expects a dir name")
    return runtime.selectSession(id, dirName)
  })

  handle(DESKTOP_CHANNELS.focusSession, (id) => {
    if (typeof id !== "number") throw new Error("focusSession expects a numeric runtime id")
    runtime.focusSession(id)
  })
  handle(DESKTOP_CHANNELS.openPane, (id, side) => {
    if (typeof id !== "number") throw new Error("openPane expects a numeric runtime id")
    if (side !== "left" && side !== "right" && side !== "top" && side !== "bottom")
      throw new Error("openPane expects a side")
    runtime.openPane(id, side)
  })
  handle(DESKTOP_CHANNELS.closePane, (id) => {
    if (typeof id !== "number") throw new Error("closePane expects a numeric runtime id")
    runtime.closePane(id)
  })
  handle(DESKTOP_CHANNELS.soloPane, (id) => {
    if (typeof id !== "number") throw new Error("soloPane expects a numeric runtime id")
    runtime.soloPane(id)
  })
  handle(DESKTOP_CHANNELS.replacePane, (target, id) => {
    if (typeof target !== "number" || typeof id !== "number")
      throw new Error("replacePane expects numeric runtime ids")
    runtime.replacePane(target, id)
  })

  handle(DESKTOP_CHANNELS.searchSessions, (query) => {
    if (typeof query !== "string") throw new Error("searchSessions expects a string query")
    return runtime.searchSessions(query)
  })

  handle(DESKTOP_CHANNELS.startNewSession, () => runtime.startNewSession())

  handle(DESKTOP_CHANNELS.openSessionAt, (workspacePath, sessionId, dirName) => {
    if (typeof workspacePath !== "string" || typeof sessionId !== "string") {
      throw new Error("openSessionAt expects a workspace path and a session id")
    }
    if (dirName !== undefined && typeof dirName !== "string")
      throw new Error("openSessionAt expects a dir name")
    return runtime.switchWorkspace(workspacePath, sessionId, dirName)
  })

  handle(DESKTOP_CHANNELS.openWorkspace, (path) => {
    if (typeof path !== "string" || !path) throw new Error("openWorkspace expects a path")
    return runtime.openWorkspace(path)
  })
  handle(DESKTOP_CHANNELS.locateWorkspace, (path) => {
    if (typeof path !== "string" || !path) throw new Error("locateWorkspace expects a path")
    return runtime.locateWorkspace(path)
  })

  ipcMain.handle(DESKTOP_CHANNELS.pickWorkspaceFolder, async (event: IpcMainInvokeEvent) => {
    assertTrustedSender(event)
    const result = await dialog.showOpenDialog(
      BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getAllWindows()[0],
      {
        title: "Open Folder",
        properties: ["openDirectory", "createDirectory"],
      },
    )
    return result.canceled ? undefined : result.filePaths[0]
  })

  handle(DESKTOP_CHANNELS.registerWorkspace, (dirName, path) => {
    if (typeof dirName !== "string" || typeof path !== "string") {
      throw new Error("registerWorkspace expects a session dir name and a path")
    }
    return runtime.registerWorkspace(dirName, path)
  })

  handle(DESKTOP_CHANNELS.refreshSessions, () => runtime.refreshSessions())

  handle(DESKTOP_CHANNELS.deleteSession, (id, dirName) => {
    if (typeof id !== "string") throw new Error("deleteSession expects a string id")
    if (dirName !== undefined && typeof dirName !== "string")
      throw new Error("deleteSession expects a dir name")
    return runtime.deleteSession(id, dirName)
  })

  handle(DESKTOP_CHANNELS.listModels, () => runtime.listModels())

  handle(DESKTOP_CHANNELS.selectModel, (id) => {
    if (typeof id !== "string") throw new Error("selectModel expects a string id")
    return runtime.selectModel(id)
  })

  handle(DESKTOP_CHANNELS.cancelModelSelection, () => runtime.cancelModelSelection())
  handle(DESKTOP_CHANNELS.setAgentsPanelVisible, (visible) => {
    if (typeof visible !== "boolean") throw new Error("Invalid visibility flag.")
    return runtime.setAgentsPanelVisible(visible)
  })
  handle(DESKTOP_CHANNELS.setWorkspacePanelWidth, (width) => {
    if (width !== undefined && (typeof width !== "number" || !Number.isFinite(width) || width <= 0))
      throw new Error("Invalid panel width.")
    return runtime.setWorkspacePanelWidth(width)
  })
  handle(DESKTOP_CHANNELS.setTheme, (theme) => {
    if (typeof theme !== "string") throw new Error("Invalid theme.")
    return runtime.setTheme(theme)
  })
  handle(DESKTOP_CHANNELS.setLanguage, (language) => {
    if (typeof language !== "string") throw new Error("Invalid language.")
    return runtime.setLanguage(language)
  })
  handle(DESKTOP_CHANNELS.setThinkingVisible, (visible) => {
    if (typeof visible !== "boolean") throw new Error("Invalid visibility flag.")
    return runtime.setThinkingVisible(visible)
  })
  handle(DESKTOP_CHANNELS.setLocalThinking, (model, level) => {
    if (typeof model !== "string" || typeof level !== "string")
      throw new Error("Invalid thinking effort.")
    return runtime.setLocalThinking(model, level)
  })
  handle(DESKTOP_CHANNELS.setPermissionMode, (mode) => {
    if (mode !== "ask" && mode !== "auto") throw new Error("Invalid permission mode.")
    return runtime.setPermissionMode(mode)
  })
  handle(DESKTOP_CHANNELS.setFastServing, (fast) => {
    if (typeof fast !== "boolean") throw new Error("Invalid Fast serving flag.")
    return runtime.setFastServing(fast)
  })
  // Mirrors FIREWORKS_KEY_URL in src/cli/provider-links.ts; the CLI module spawns open/xdg-open,
  // the desktop main uses Electron's shell instead.
  handle(DESKTOP_CHANNELS.openFireworksKeyPage, () =>
    shell.openExternal("https://app.fireworks.ai/api-keys"),
  )
  handle(DESKTOP_CHANNELS.setFireworksApiKey, (apiKey) => {
    if (typeof apiKey !== "string") throw new Error("Invalid API key.")
    return runtime.setFireworksApiKey(apiKey)
  })
  handle(DESKTOP_CHANNELS.connectLocalServers, (endpoints) => {
    if (
      !endpoints ||
      typeof endpoints !== "object" ||
      Array.isArray(endpoints) ||
      Object.entries(endpoints).some(
        ([key, value]) =>
          !["ollama", "lmStudio", "omlx", "omlxApiKey"].includes(key) ||
          (value !== undefined && typeof value !== "string"),
      )
    )
      throw new Error("Invalid local server settings.")
    return runtime.connectLocalServers(endpoints)
  })
  handle(DESKTOP_CHANNELS.deleteLocalModel, (id) => {
    if (typeof id !== "string") throw new Error("Invalid model id.")
    return runtime.deleteLocalModel(id)
  })
  handle(DESKTOP_CHANNELS.checkForUpdates, () => runtime.checkForUpdates())
  handle(DESKTOP_CHANNELS.installUpdate, () => runtime.installUpdate())
  handle(DESKTOP_CHANNELS.setDebugMode, (enabled) => {
    if (typeof enabled !== "boolean") throw new Error("Invalid debug flag.")
    return runtime.setDebugMode(enabled)
  })
  handle(DESKTOP_CHANNELS.getSubagentTrace, (toolCallId) => {
    if (typeof toolCallId !== "string" || !toolCallId) throw new Error("Invalid tool call id.")
    return runtime.getSubagentTrace(toolCallId)
  })
}

function handle<T extends unknown[]>(channel: string, handler: (...args: T) => unknown) {
  ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    assertTrustedSender(event)
    return handler(...(args as T))
  })
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
