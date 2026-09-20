import { extname } from "node:path"
import { BrowserWindow, dialog, type IpcMainInvokeEvent, ipcMain, shell } from "electron"
import { isArtifactReference } from "../../artifacts/types.js"
import { DESKTOP_CHANNELS, type DesktopAttachmentInput } from "../contracts.js"
import { saveArtifactCopy } from "./artifact-export.js"
import type { DesktopRuntime } from "./runtime.js"

/**
 * Registers the validated IPC handlers for the desktop API. Every handler checks that the call comes from our own
 * renderer before touching the runtime, and validates payload shapes at the boundary.
 */
export function registerDesktopIpc(runtime: DesktopRuntime) {
  handle(DESKTOP_CHANNELS.getSnapshot, () => runtime.snapshot())
  handle(DESKTOP_CHANNELS.getArtifact, (revision) => {
    if (typeof revision !== "number") throw new Error("getArtifact expects a numeric revision")
    return runtime.getArtifact(revision)
  })
  handle(DESKTOP_CHANNELS.openArtifact, (reference, version) => {
    if (!isArtifactReference(reference)) throw new Error("openArtifact expects a valid artifact reference")
    if (version !== undefined && (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1))
      throw new Error("openArtifact expects a positive integer version")
    return runtime.openArtifact(reference, version)
  })

  ipcMain.handle(DESKTOP_CHANNELS.saveArtifact, async (event: IpcMainInvokeEvent, id: unknown, revision: unknown) => {
    assertTrustedSender(event)
    if (typeof id !== "string" || !id) throw new Error("saveArtifact expects an artifact id")
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)
      throw new Error("saveArtifact expects a numeric revision")
    const file = await runtime.getArtifactFile(id, revision)
    if (!file) return { ok: false, reason: "This preview changed. Try saving the current version again." }
    return saveArtifactCopy(file, async (name) => {
      const result = await dialog.showSaveDialog(
        BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getAllWindows()[0],
        {
          defaultPath: name,
          filters: [{ name: extname(name).slice(1).toUpperCase(), extensions: [extname(name).slice(1)] }],
          properties: ["showOverwriteConfirmation", "createDirectory"],
        },
      )
      return result.canceled ? undefined : result.filePath
    })
  })

  ipcMain.handle(DESKTOP_CHANNELS.getWindowState, (event: IpcMainInvokeEvent) => {
    assertTrustedSender(event)
    return { fullscreen: BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false }
  })

  handle(DESKTOP_CHANNELS.sendPrompt, (text, attachments) => {
    if (typeof text !== "string") throw new Error("sendPrompt expects a string")
    if (attachments !== undefined && !isDesktopAttachmentInputs(attachments)) {
      throw new Error("sendPrompt expects valid attachments")
    }
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
    if (dirName !== undefined && typeof dirName !== "string") throw new Error("selectSession expects a dir name")
    return runtime.selectSession(id, dirName)
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
    if (dirName !== undefined && typeof dirName !== "string") throw new Error("openSessionAt expects a dir name")
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
    if (dirName !== undefined && typeof dirName !== "string") throw new Error("deleteSession expects a dir name")
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
    if (typeof model !== "string" || typeof level !== "string") throw new Error("Invalid thinking effort.")
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
  // Mirrors FIREWORKS_KEY_URL in src/cli/provider-links.ts; the CLI module spawns open/xdg-open, the desktop
  // main uses Electron's shell instead.
  handle(DESKTOP_CHANNELS.openFireworksKeyPage, () => shell.openExternal("https://app.fireworks.ai/api-keys"))
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

function isDesktopAttachmentInputs(value: unknown): value is DesktopAttachmentInput[] {
  return (
    Array.isArray(value) &&
    value.every(
      (attachment) =>
        typeof attachment === "object" &&
        attachment !== null &&
        typeof attachment.name === "string" &&
        typeof attachment.mimeType === "string" &&
        attachment.bytes instanceof Uint8Array,
    )
  )
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
