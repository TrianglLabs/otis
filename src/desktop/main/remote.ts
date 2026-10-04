import { WebSocket } from "ws"
import {
  isThemeName,
  type LocalSettings,
  loadLocalSettings,
  saveSelectedTheme,
  saveSubagentPanelVisible,
  saveTextSize,
  saveThinkingVisible,
  saveUiLanguage,
  saveWorkspacePanelWidth,
  TEXT_SIZES,
  UI_LANGUAGES,
} from "../../local/settings.js"
import type { DesktopEvent, DesktopSnapshot, DesktopStatus } from "../contracts.js"
import { decode, encode, MAX_FRAME, type ServerMessage, type SessionNotice } from "../wire.js"
import type { DesktopBackend } from "./api.js"

export type RemoteConnection = { url: string; token: string }

/**
 * A daemon reached over the wire, as the window's backend. Sessions, models, keys, skills, memory
 * and completion notices are the daemon's; how this window looks (theme, text size, language,
 * thinking traces, panels) and this app's updates stay on this machine, so the overlay answers
 * those calls and status fields itself.
 */
export async function connectRemote(
  remote: RemoteConnection,
  handlers: {
    platform: NodeJS.Platform
    version: string
    onEvent(event: DesktopEvent): void
    onTerminal(data: string): void
    onNotify(notice: SessionNotice): void
    /** A paired daemon went away; the connection is not retried. */
    onClose(): void
    checkForUpdates(): Promise<void>
    installUpdate(): Promise<void>
  },
): Promise<DesktopBackend> {
  const local = await loadLocalSettings()
  let update: DesktopStatus["update"] = { status: "idle" }
  // The daemon numbers its events; a status the overlay re-emits on its own takes a number above
  // them, and every later daemon number moves up by as many as were taken, so the renderer's
  // revision guard keeps accepting. `last` never moves backwards: a snapshot can arrive after an
  // event that was numbered past it.
  let last: { revision: number; status: DesktopStatus } | undefined
  let bumps = 0
  const host = new URL(remote.url).host
  const overlay = <T extends DesktopStatus>(status: T): T => ({
    ...status,
    remote: host,
    theme: local.theme ?? "default",
    textSize: local.textSize ?? "default",
    language: local.language ?? "system",
    thinkingVisible: local.thinkingVisible ?? false,
    agentsPanelVisible: local.subagentPanelVisible ?? true,
    workspacePanelWidth: local.workspacePanelWidth,
    update,
  })
  const restate = () => {
    if (!last) return
    bumps += 1
    handlers.onEvent({
      type: "status",
      revision: last.revision + bumps,
      status: overlay(last.status),
    })
  }
  const socket = new WebSocket(remote.url, {
    headers: { authorization: `Bearer ${remote.token}` },
    handshakeTimeout: 10_000,
    maxPayload: MAX_FRAME,
  })
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve)
    // Stays attached: a later transport error is reported by the close that follows it.
    socket.on("error", (error) =>
      reject(
        new Error(
          error.message.includes("401")
            ? `${host} rejected the pairing token.`
            : `Couldn't reach ${host}: ${error.message}`,
        ),
      ),
    )
  })
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  let nextId = 1
  let lost: Error | undefined
  socket.on("message", (raw) => {
    const message = decode(raw.toString()) as ServerMessage
    if ("event" in message) {
      const event = { ...message.event, revision: message.event.revision + bumps }
      if (event.type === "status") {
        last = { revision: message.event.revision, status: event.status }
        handlers.onEvent({ ...event, status: overlay(event.status) })
      } else handlers.onEvent(event)
    } else if ("terminal" in message) handlers.onTerminal(message.terminal)
    else if ("notify" in message) handlers.onNotify(message.notify)
    else {
      const call = pending.get(message.id)
      pending.delete(message.id)
      if ("error" in message) call?.reject(new Error(message.error))
      else call?.resolve(message.result)
    }
  })
  socket.on("close", () => {
    lost = new Error(`Lost the connection to ${host}.`)
    for (const call of pending.values()) call.reject(lost)
    pending.clear()
    handlers.onClose()
  })
  const forward = (method: string, args: unknown[]) =>
    lost
      ? Promise.reject(lost)
      : new Promise<unknown>((resolve, reject) => {
          const id = nextId++
          pending.set(id, { resolve, reject })
          socket.send(encode({ id, method, args }))
        })
  // A window preference: saved here, shown here, never sent to the daemon.
  const keep = async <K extends keyof LocalSettings>(
    key: K,
    value: LocalSettings[K],
    save: () => Promise<unknown>,
  ) => {
    await save()
    local[key] = value
    restate()
  }
  const here: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    getSnapshot: async () => {
      const snapshot = (await forward("getSnapshot", [])) as DesktopSnapshot
      // Only the status part is kept: a restate must not ship the transcript again, and the
      // window's platform and version are this app's, set below.
      const {
        entries: _entries,
        transcripts: _transcripts,
        platform: _platform,
        version: _version,
        revision,
        ...status
      } = snapshot
      if (!last || revision >= last.revision) last = { revision, status }
      return {
        ...overlay(snapshot),
        revision: revision + bumps,
        platform: handlers.platform,
        version: handlers.version,
      }
    },
    setTheme: (theme) => {
      if (!isThemeName(theme)) throw new Error("Invalid theme.")
      return keep("theme", theme, () => saveSelectedTheme(theme))
    },
    setTextSize: (textSize) => {
      const size = TEXT_SIZES.find((known) => known === textSize)
      if (!size) throw new Error("Invalid text size.")
      return keep("textSize", size, () => saveTextSize(size))
    },
    setLanguage: (language) => {
      const selected = UI_LANGUAGES.find((known) => known === language)
      if (!selected) throw new Error("Invalid language.")
      return keep("language", selected, () => saveUiLanguage(selected))
    },
    setThinkingVisible: (visible) => {
      if (typeof visible !== "boolean") throw new Error("Invalid visibility flag.")
      return keep("thinkingVisible", visible, () => saveThinkingVisible(visible))
    },
    setAgentsPanelVisible: (visible) => {
      if (typeof visible !== "boolean") throw new Error("Invalid visibility flag.")
      return keep("subagentPanelVisible", visible, () => saveSubagentPanelVisible(visible))
    },
    setWorkspacePanelWidth: (width) => {
      if (
        width !== undefined &&
        !(typeof width === "number" && Number.isFinite(width) && width > 0)
      )
        throw new Error("Invalid panel width.")
      return keep("workspacePanelWidth", width, () => saveWorkspacePanelWidth(width))
    },
    checkForUpdates: () => handlers.checkForUpdates(),
    installUpdate: () => handlers.installUpdate(),
  }
  return {
    call: (method, args) => (here[method] ? here[method](...args) : forward(method, args)),
    setUpdateState(state) {
      update = state
      restate()
    },
    rendererGone() {},
    async shutdown() {
      socket.removeAllListeners("close")
      socket.close(1000, "The window is closing.")
    },
  }
}
