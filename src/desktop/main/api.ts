import type { LocalServerInputs } from "../../app/local-servers.js"
import { isArtifactReference } from "../../artifacts/types.js"
import { isRecord } from "../../inference/errors.js"
import { isHostedProvider, isServerProvider } from "../../inference/types.js"
import { TEXT_SIZES } from "../../local/settings.js"
import { isMemoryScope } from "../../memory/memory.js"
import type {
  DesktopAttachmentInput,
  DesktopStatus,
  PaneDrop,
  PaneSide,
  RoutineInput,
} from "../contracts.js"
import type { DesktopRuntime } from "./runtime.js"

/**
 * The runtime the window talks to, by method name: the one in this process, or a daemon reached
 * over the wire. Events, terminal output and notices arrive through the callbacks each backend was
 * built with.
 */
export type DesktopBackend = {
  call(method: string, args: unknown[]): Promise<unknown>
  /** Update state belongs to this process's updater, whichever runtime serves the window. */
  setUpdateState(update: DesktopStatus["update"]): void
  /** The window's renderer died; a local runtime stops its turns. */
  rendererGone(): void
  shutdown(): Promise<void>
}

/**
 * The desktop API over a runtime, by method name, validating every payload at the boundary. Both
 * the IPC layer and the daemon dispatch through it, so a caller is trusted only as far as its
 * arguments check out.
 */
export function desktopCall(runtime: DesktopRuntime) {
  const methods = {
    getSnapshot: () => runtime.snapshot(),
    getArtifact: (target: unknown, id: unknown, revision: unknown) => {
      if (typeof target !== "number") throw new Error("getArtifact expects a numeric runtime id")
      if (typeof id !== "string" || !id) throw new Error("getArtifact expects an artifact id")
      if (typeof revision !== "number") throw new Error("getArtifact expects a numeric revision")
      return runtime.getArtifact(target, id, revision)
    },
    getArtifactAsset: (target: unknown, id: unknown, revision: unknown, src: unknown) => {
      if (typeof target !== "number")
        throw new Error("getArtifactAsset expects a numeric runtime id")
      if (typeof id !== "string" || !id) throw new Error("getArtifactAsset expects an artifact id")
      if (typeof revision !== "number")
        throw new Error("getArtifactAsset expects a numeric revision")
      if (typeof src !== "string" || !src || src.length > 1024)
        throw new Error("getArtifactAsset expects a relative image path")
      return runtime.getArtifactAsset(target, id, revision, src)
    },
    /** The exact bytes of a revision, for the client's native Save dialog. */
    getArtifactFile: (target: unknown, id: unknown, revision: unknown) => {
      if (typeof target !== "number")
        throw new Error("getArtifactFile expects a numeric runtime id")
      if (typeof id !== "string" || !id) throw new Error("getArtifactFile expects an artifact id")
      if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)
        throw new Error("getArtifactFile expects a numeric revision")
      return runtime.getArtifactFile(target, id, revision)
    },
    openArtifact: (reference: unknown, version: unknown, target: unknown) => {
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
    },
    openPublishedArtifact: (artifactId: unknown, target: unknown) => {
      if (typeof artifactId !== "string")
        throw new Error("openPublishedArtifact expects an artifact id")
      if (target !== undefined && typeof target !== "number")
        throw new Error("openPublishedArtifact expects a numeric runtime id")
      return runtime.openPublishedArtifact(artifactId, target)
    },
    closeArtifact: (target: unknown, id: unknown) => {
      if (typeof target !== "number") throw new Error("closeArtifact expects a numeric runtime id")
      if (typeof id !== "string" || !id) throw new Error("closeArtifact expects an artifact id")
      runtime.closeArtifact(target, id)
    },
    sendPrompt: (text: unknown, attachments: unknown) => {
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
    },
    stop: () => runtime.stop(),
    openTerminal: () => runtime.openTerminal(),
    writeTerminal: (data: unknown) => {
      if (typeof data !== "string") throw new Error("writeTerminal expects a string")
      return runtime.writeTerminal(data)
    },
    resizeTerminal: (cols: unknown, rows: unknown) => {
      if (![cols, rows].every((v) => typeof v === "number" && Number.isSafeInteger(v) && v > 0))
        throw new Error("resizeTerminal expects a size in cells")
      return runtime.resizeTerminal(cols as number, rows as number)
    },
    closeTerminal: () => runtime.closeTerminal(),
    respondToPermission: (id: unknown, allow: unknown) => {
      if (typeof id !== "number" || typeof allow !== "boolean")
        throw new Error("respondToPermission expects a numeric id and a boolean decision")
      runtime.respondToPermission(id, allow)
    },
    selectSession: (id: unknown, dirName: unknown, at: unknown) => {
      if (typeof id !== "string") throw new Error("selectSession expects a string id")
      if (dirName !== undefined && typeof dirName !== "string")
        throw new Error("selectSession expects a dir name")
      if (at !== undefined && !isPaneDrop(at))
        throw new Error("selectSession expects a drop target")
      return runtime.selectSession(id, dirName, at)
    },
    focusSession: (id: unknown) => {
      if (typeof id !== "number") throw new Error("focusSession expects a numeric runtime id")
      runtime.focusSession(id)
    },
    openPane: (id: unknown, side: unknown) => {
      if (typeof id !== "number") throw new Error("openPane expects a numeric runtime id")
      if (!isPaneSide(side)) throw new Error("openPane expects a side")
      runtime.openPane(id, side)
    },
    closePane: (id: unknown) => {
      if (typeof id !== "number") throw new Error("closePane expects a numeric runtime id")
      runtime.closePane(id)
    },
    soloPane: (id: unknown) => {
      if (typeof id !== "number") throw new Error("soloPane expects a numeric runtime id")
      runtime.soloPane(id)
    },
    replacePane: (target: unknown, id: unknown) => {
      if (typeof target !== "number" || typeof id !== "number")
        throw new Error("replacePane expects numeric runtime ids")
      runtime.replacePane(target, id)
    },
    searchSessions: (query: unknown) => {
      if (typeof query !== "string") throw new Error("searchSessions expects a string query")
      return runtime.searchSessions(query)
    },
    startNewSession: () => runtime.startNewSession(),
    openSessionAt: (workspacePath: unknown, sessionId: unknown, dirName: unknown) => {
      if (typeof workspacePath !== "string" || typeof sessionId !== "string")
        throw new Error("openSessionAt expects a workspace path and a session id")
      if (dirName !== undefined && typeof dirName !== "string")
        throw new Error("openSessionAt expects a dir name")
      return runtime.switchWorkspace(workspacePath, sessionId, dirName)
    },
    openWorkspace: (path: unknown) => {
      if (typeof path !== "string" || !path) throw new Error("openWorkspace expects a path")
      return runtime.openWorkspace(path)
    },
    locateWorkspace: (path: unknown) => {
      if (typeof path !== "string" || !path) throw new Error("locateWorkspace expects a path")
      return runtime.locateWorkspace(path)
    },
    registerWorkspace: (dirName: unknown, path: unknown) => {
      if (typeof dirName !== "string" || typeof path !== "string")
        throw new Error("registerWorkspace expects a session dir name and a path")
      return runtime.registerWorkspace(dirName, path)
    },
    refreshSessions: () => runtime.refreshSessions(),
    deleteSession: (id: unknown, dirName: unknown) => {
      if (typeof id !== "string") throw new Error("deleteSession expects a string id")
      if (dirName !== undefined && typeof dirName !== "string")
        throw new Error("deleteSession expects a dir name")
      return runtime.deleteSession(id, dirName)
    },
    listModels: () => runtime.listModels(),
    listHostedCatalogs: () => runtime.listHostedCatalogs(),
    setModelHidden: (provider: unknown, id: unknown, hidden: unknown) => {
      if (!isHostedProvider(provider)) throw new Error("Invalid hosted provider.")
      if (typeof id !== "string" || !id) throw new Error("Invalid model id.")
      if (typeof hidden !== "boolean") throw new Error("Invalid visibility flag.")
      return runtime.setModelHidden(provider, id, hidden)
    },
    setPrimeTeamId: (teamId: unknown) => {
      if (typeof teamId !== "string") throw new Error("Invalid team id.")
      return runtime.setPrimeTeamId(teamId)
    },
    selectModel: (id: unknown) => {
      if (typeof id !== "string") throw new Error("selectModel expects a string id")
      return runtime.selectModel(id)
    },
    cancelModelSelection: () => runtime.cancelModelSelection(),
    setAgentsPanelVisible: (visible: unknown) => {
      if (typeof visible !== "boolean") throw new Error("Invalid visibility flag.")
      return runtime.setAgentsPanelVisible(visible)
    },
    setWorkspacePanelWidth: (width: unknown) => {
      if (
        width !== undefined &&
        (typeof width !== "number" || !Number.isFinite(width) || width <= 0)
      )
        throw new Error("Invalid panel width.")
      return runtime.setWorkspacePanelWidth(width)
    },
    markAchievementsSeen: () => runtime.markAchievementsSeen(),
    setTheme: (theme: unknown) => {
      if (typeof theme !== "string") throw new Error("Invalid theme.")
      return runtime.setTheme(theme)
    },
    setTextSize: (textSize: unknown) => {
      const size = TEXT_SIZES.find((known) => known === textSize)
      if (!size) throw new Error("Invalid text size.")
      return runtime.setTextSize(size)
    },
    setLanguage: (language: unknown) => {
      if (typeof language !== "string") throw new Error("Invalid language.")
      return runtime.setLanguage(language)
    },
    setThinkingVisible: (visible: unknown) => {
      if (typeof visible !== "boolean") throw new Error("Invalid visibility flag.")
      return runtime.setThinkingVisible(visible)
    },
    setNotifyOnCompletion: (enabled: unknown) => {
      if (typeof enabled !== "boolean") throw new Error("Invalid notification flag.")
      return runtime.setNotifyOnCompletion(enabled)
    },
    setLocalThinking: (model: unknown, level: unknown) => {
      if (typeof model !== "string" || typeof level !== "string")
        throw new Error("Invalid thinking effort.")
      return runtime.setLocalThinking(model, level)
    },
    setPermissionMode: (mode: unknown) => {
      if (mode !== "ask" && mode !== "auto") throw new Error("Invalid permission mode.")
      return runtime.setPermissionMode(mode)
    },
    setFastServing: (fast: unknown) => {
      if (typeof fast !== "boolean") throw new Error("Invalid Fast serving flag.")
      return runtime.setFastServing(fast)
    },
    setHostedApiKey: (provider: unknown, apiKey: unknown) => {
      if (!isHostedProvider(provider)) throw new Error("Invalid hosted provider.")
      if (typeof apiKey !== "string") throw new Error("Invalid API key.")
      return runtime.setHostedApiKey(provider, apiKey)
    },
    connectLocalServers: (endpoints: unknown) => {
      const text = (value: unknown) => value === undefined || typeof value === "string"
      const valid =
        isRecord(endpoints) &&
        Object.entries(endpoints).every(([key, value]) =>
          isServerProvider(key)
            ? value === undefined ||
              (isRecord(value) &&
                typeof value.baseURL === "string" &&
                Object.entries(value).every(
                  ([field, entry]) =>
                    ["baseURL", "apiKey", "model", "contextLength"].includes(field) && text(entry),
                ))
            : ["ollama", "lmStudio"].includes(key) && text(value),
        )
      if (!valid) throw new Error("Invalid local server settings.")
      return runtime.connectLocalServers(endpoints as LocalServerInputs)
    },
    deleteLocalModel: (id: unknown) => {
      if (typeof id !== "string") throw new Error("Invalid model id.")
      return runtime.deleteLocalModel(id)
    },
    listSkills: () => runtime.listSkills(),
    installSkills: (url: unknown) => {
      if (typeof url !== "string") throw new Error("installSkills expects a Git URL")
      return runtime.installSkills(url)
    },
    updateSkills: (id: unknown) => {
      if (typeof id !== "string") throw new Error("updateSkills expects an id")
      return runtime.updateSkills(id)
    },
    removeSkills: (id: unknown) => {
      if (typeof id !== "string") throw new Error("removeSkills expects an id")
      return runtime.removeSkills(id)
    },
    saveRoutine: (routine: unknown) => {
      const text = (value: unknown) => typeof value === "string"
      if (
        !isRecord(routine) ||
        !text(routine.name) ||
        !text(routine.prompt) ||
        !text(routine.cwd) ||
        !isRecord(routine.schedule) ||
        (routine.model !== undefined && !text(routine.model)) ||
        typeof routine.auto !== "boolean" ||
        typeof routine.enabled !== "boolean" ||
        (routine.id !== undefined && !text(routine.id))
      )
        throw new Error("Invalid routine.")
      return runtime.saveRoutine(routine as RoutineInput)
    },
    deleteRoutine: (id: unknown) => {
      if (typeof id !== "string") throw new Error("Invalid routine id.")
      return runtime.deleteRoutine(id)
    },
    runRoutine: (id: unknown) => {
      if (typeof id !== "string") throw new Error("Invalid routine id.")
      return runtime.runRoutine(id)
    },
    cancelRoutine: (id: unknown) => {
      if (typeof id !== "string") throw new Error("Invalid routine id.")
      return runtime.cancelRoutine(id)
    },
    listMemory: () => runtime.listMemory(),
    rememberFact: (scope: unknown, fact: unknown) => {
      if (!isMemoryScope(scope) || typeof fact !== "string") throw new Error("Invalid memory fact.")
      return runtime.rememberFact(scope, fact)
    },
    forgetFact: (scope: unknown, fact: unknown) => {
      if (!isMemoryScope(scope) || typeof fact !== "string") throw new Error("Invalid memory fact.")
      return runtime.forgetFact(scope, fact)
    },
    checkForUpdates: () => runtime.checkForUpdates(),
    installUpdate: () => runtime.installUpdate(),
    setDebugMode: (enabled: unknown) => {
      if (typeof enabled !== "boolean") throw new Error("Invalid debug flag.")
      return runtime.setDebugMode(enabled)
    },
    getSubagentTrace: (toolCallId: unknown) => {
      if (typeof toolCallId !== "string" || !toolCallId) throw new Error("Invalid tool call id.")
      return runtime.getSubagentTrace(toolCallId)
    },
  }
  return (method: string, args: unknown[]) => {
    const handler = methods[method as keyof typeof methods] as
      | ((...args: unknown[]) => unknown)
      | undefined
    if (!handler) throw new Error(`Unknown desktop method: ${method}`)
    return handler(...args)
  }
}

/** The runtime in this process as a backend. */
export function localBackend(runtime: DesktopRuntime): DesktopBackend {
  const call = desktopCall(runtime)
  return {
    call: async (method, args) => call(method, args),
    setUpdateState: (update) => runtime.setUpdateState(update),
    rendererGone: () => runtime.handleRendererGone(),
    shutdown: () => runtime.shutdown(),
  }
}

function isPaneSide(value: unknown): value is PaneSide {
  return value === "left" || value === "right" || value === "top" || value === "bottom"
}

function isPaneDrop(value: unknown): value is PaneDrop {
  if (typeof value !== "object" || value === null) return false
  return (
    ("side" in value && isPaneSide(value.side)) ||
    ("replace" in value && typeof value.replace === "number")
  )
}
