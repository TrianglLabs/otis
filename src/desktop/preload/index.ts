import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron"
import {
  DESKTOP_CHANNELS,
  type DesktopApi,
  type DesktopEvent,
  type DesktopWindowState,
} from "../contracts.js"

/** Electron reports a rejection as "Error invoking remote method '…': Error: <reason>". */
const invoke = (channel: string, ...args: unknown[]) =>
  ipcRenderer.invoke(channel, ...args).catch((error: Error) => {
    throw new Error(
      error.message.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, ""),
    )
  })

const api: DesktopApi = {
  getSnapshot: () => invoke(DESKTOP_CHANNELS.getSnapshot),
  getArtifact: (runtime, id, revision) =>
    invoke(DESKTOP_CHANNELS.getArtifact, runtime, id, revision),
  closeArtifact: (runtime, id) => invoke(DESKTOP_CHANNELS.closeArtifact, runtime, id),
  openArtifact: (reference, version, runtime) =>
    invoke(DESKTOP_CHANNELS.openArtifact, reference, version, runtime),
  saveArtifact: (runtime, id, revision) =>
    invoke(DESKTOP_CHANNELS.saveArtifact, runtime, id, revision),
  getWindowState: () => invoke(DESKTOP_CHANNELS.getWindowState),
  sendPrompt: (text, attachments) => invoke(DESKTOP_CHANNELS.sendPrompt, text, attachments),
  stop: () => invoke(DESKTOP_CHANNELS.stop),
  respondToPermission: (id, allow) => invoke(DESKTOP_CHANNELS.respondToPermission, id, allow),
  selectSession: (id, dirName) => invoke(DESKTOP_CHANNELS.selectSession, id, dirName),
  focusSession: (runtime) => invoke(DESKTOP_CHANNELS.focusSession, runtime),
  openPane: (runtime, side) => invoke(DESKTOP_CHANNELS.openPane, runtime, side),
  closePane: (runtime) => invoke(DESKTOP_CHANNELS.closePane, runtime),
  soloPane: (runtime) => invoke(DESKTOP_CHANNELS.soloPane, runtime),
  replacePane: (target, runtime) => invoke(DESKTOP_CHANNELS.replacePane, target, runtime),
  searchSessions: (query) => invoke(DESKTOP_CHANNELS.searchSessions, query),
  startNewSession: () => invoke(DESKTOP_CHANNELS.startNewSession),
  openSessionAt: (workspacePath, sessionId, dirName) =>
    invoke(DESKTOP_CHANNELS.openSessionAt, workspacePath, sessionId, dirName),
  openWorkspace: (path) => invoke(DESKTOP_CHANNELS.openWorkspace, path),
  locateWorkspace: (path) => invoke(DESKTOP_CHANNELS.locateWorkspace, path),
  pickWorkspaceFolder: () => invoke(DESKTOP_CHANNELS.pickWorkspaceFolder),
  registerWorkspace: (dirName, path) => invoke(DESKTOP_CHANNELS.registerWorkspace, dirName, path),
  deleteSession: (id, dirName) => invoke(DESKTOP_CHANNELS.deleteSession, id, dirName),
  refreshSessions: () => invoke(DESKTOP_CHANNELS.refreshSessions),
  listModels: () => invoke(DESKTOP_CHANNELS.listModels),
  selectModel: (id) => invoke(DESKTOP_CHANNELS.selectModel, id),
  cancelModelSelection: () => invoke(DESKTOP_CHANNELS.cancelModelSelection),
  getSubagentTrace: (toolCallId) => invoke(DESKTOP_CHANNELS.getSubagentTrace, toolCallId),
  setAgentsPanelVisible: (visible) => invoke(DESKTOP_CHANNELS.setAgentsPanelVisible, visible),
  setWorkspacePanelWidth: (width) => invoke(DESKTOP_CHANNELS.setWorkspacePanelWidth, width),
  setTheme: (theme) => invoke(DESKTOP_CHANNELS.setTheme, theme),
  setLanguage: (language) => invoke(DESKTOP_CHANNELS.setLanguage, language),
  setThinkingVisible: (visible) => invoke(DESKTOP_CHANNELS.setThinkingVisible, visible),
  setNotifyOnCompletion: (enabled) => invoke(DESKTOP_CHANNELS.setNotifyOnCompletion, enabled),
  setLocalThinking: (model, level) => invoke(DESKTOP_CHANNELS.setLocalThinking, model, level),
  setPermissionMode: (mode) => invoke(DESKTOP_CHANNELS.setPermissionMode, mode),
  setFastServing: (fast) => invoke(DESKTOP_CHANNELS.setFastServing, fast),
  openFireworksKeyPage: () => invoke(DESKTOP_CHANNELS.openFireworksKeyPage),
  setFireworksApiKey: (apiKey) => invoke(DESKTOP_CHANNELS.setFireworksApiKey, apiKey),
  connectLocalServers: (endpoints) => invoke(DESKTOP_CHANNELS.connectLocalServers, endpoints),
  deleteLocalModel: (id) => invoke(DESKTOP_CHANNELS.deleteLocalModel, id),
  setDebugMode: (enabled) => invoke(DESKTOP_CHANNELS.setDebugMode, enabled),
  checkForUpdates: () => invoke(DESKTOP_CHANNELS.checkForUpdates),
  installUpdate: () => invoke(DESKTOP_CHANNELS.installUpdate),
  subscribeWindowState: (listener) => {
    const wrapped = (_event: IpcRendererEvent, state: DesktopWindowState) => listener(state)
    ipcRenderer.on(DESKTOP_CHANNELS.windowState, wrapped)
    return () => ipcRenderer.removeListener(DESKTOP_CHANNELS.windowState, wrapped)
  },
  subscribe: (listener) => {
    const wrapped = (_event: IpcRendererEvent, payload: DesktopEvent) => listener(payload)
    ipcRenderer.on(DESKTOP_CHANNELS.event, wrapped)
    return () => ipcRenderer.removeListener(DESKTOP_CHANNELS.event, wrapped)
  },
}

contextBridge.exposeInMainWorld("otis", api)
