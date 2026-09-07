import { type IpcMainInvokeEvent, ipcMain, shell } from "electron"
import { DESKTOP_CHANNELS } from "../contracts.js"
import type { DesktopRuntime } from "./runtime.js"

/**
 * Registers the validated IPC handlers for the desktop API. Every handler checks that the call comes from our own
 * renderer before touching the runtime, and validates payload shapes at the boundary.
 */
export function registerDesktopIpc(runtime: DesktopRuntime) {
  handle(DESKTOP_CHANNELS.getSnapshot, () => runtime.snapshot())

  handle(DESKTOP_CHANNELS.sendPrompt, (text) => {
    if (typeof text !== "string") throw new Error("sendPrompt expects a string")
    return runtime.sendPrompt(text)
  })

  handle(DESKTOP_CHANNELS.stop, () => runtime.stop())

  handle(DESKTOP_CHANNELS.respondToPermission, (id, allow) => {
    if (typeof id !== "number" || typeof allow !== "boolean") {
      throw new Error("respondToPermission expects a numeric id and a boolean decision")
    }
    runtime.respondToPermission(id, allow)
  })

  handle(DESKTOP_CHANNELS.selectSession, (id) => {
    if (typeof id !== "string") throw new Error("selectSession expects a string id")
    return runtime.selectSession(id)
  })

  handle(DESKTOP_CHANNELS.startNewSession, () => runtime.startNewSession())

  handle(DESKTOP_CHANNELS.deleteSession, (id) => {
    if (typeof id !== "string") throw new Error("deleteSession expects a string id")
    return runtime.deleteSession(id)
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
  handle(DESKTOP_CHANNELS.setThinkingVisible, (visible) => {
    if (typeof visible !== "boolean") throw new Error("Invalid visibility flag.")
    return runtime.setThinkingVisible(visible)
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
  handle(DESKTOP_CHANNELS.connectPairEndpoints, (endpoints) => {
    if (!endpoints || typeof endpoints !== "object") throw new Error("Invalid PAIR endpoints.")
    return runtime.connectPairEndpoints(endpoints)
  })
  handle(DESKTOP_CHANNELS.listDownloadedModels, () => runtime.listDownloadedModels())
  handle(DESKTOP_CHANNELS.deleteLocalModel, (id) => {
    if (typeof id !== "string") throw new Error("Invalid model id.")
    return runtime.deleteLocalModel(id)
  })
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
