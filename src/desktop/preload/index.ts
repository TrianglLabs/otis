import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron"
import {
  DESKTOP_CHANNELS,
  type DesktopApi,
  type DesktopEvent,
  type DesktopWindowState,
} from "../contracts.js"

const api: DesktopApi = {
  getSnapshot: () => ipcRenderer.invoke(DESKTOP_CHANNELS.getSnapshot),
  getArtifact: (runtime, id, revision) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.getArtifact, runtime, id, revision),
  closeArtifact: (runtime, id) => ipcRenderer.invoke(DESKTOP_CHANNELS.closeArtifact, runtime, id),
  openArtifact: (reference, version, runtime) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.openArtifact, reference, version, runtime),
  saveArtifact: (runtime, id, revision) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.saveArtifact, runtime, id, revision),
  getWindowState: () => ipcRenderer.invoke(DESKTOP_CHANNELS.getWindowState),
  sendPrompt: (text, attachments) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.sendPrompt, text, attachments),
  stop: () => ipcRenderer.invoke(DESKTOP_CHANNELS.stop),
  respondToPermission: (id, allow) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.respondToPermission, id, allow),
  selectSession: (id, dirName) => ipcRenderer.invoke(DESKTOP_CHANNELS.selectSession, id, dirName),
  focusSession: (runtime) => ipcRenderer.invoke(DESKTOP_CHANNELS.focusSession, runtime),
  openPane: (runtime, side) => ipcRenderer.invoke(DESKTOP_CHANNELS.openPane, runtime, side),
  closePane: (runtime) => ipcRenderer.invoke(DESKTOP_CHANNELS.closePane, runtime),
  soloPane: (runtime) => ipcRenderer.invoke(DESKTOP_CHANNELS.soloPane, runtime),
  replacePane: (target, runtime) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.replacePane, target, runtime),
  searchSessions: (query) => ipcRenderer.invoke(DESKTOP_CHANNELS.searchSessions, query),
  startNewSession: () => ipcRenderer.invoke(DESKTOP_CHANNELS.startNewSession),
  openSessionAt: (workspacePath, sessionId, dirName) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.openSessionAt, workspacePath, sessionId, dirName),
  openWorkspace: (path) => ipcRenderer.invoke(DESKTOP_CHANNELS.openWorkspace, path),
  locateWorkspace: (path) => ipcRenderer.invoke(DESKTOP_CHANNELS.locateWorkspace, path),
  pickWorkspaceFolder: () => ipcRenderer.invoke(DESKTOP_CHANNELS.pickWorkspaceFolder),
  registerWorkspace: (dirName, path) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.registerWorkspace, dirName, path),
  deleteSession: (id, dirName) => ipcRenderer.invoke(DESKTOP_CHANNELS.deleteSession, id, dirName),
  refreshSessions: () => ipcRenderer.invoke(DESKTOP_CHANNELS.refreshSessions),
  listModels: () => ipcRenderer.invoke(DESKTOP_CHANNELS.listModels),
  selectModel: (id) => ipcRenderer.invoke(DESKTOP_CHANNELS.selectModel, id),
  cancelModelSelection: () => ipcRenderer.invoke(DESKTOP_CHANNELS.cancelModelSelection),
  getSubagentTrace: (toolCallId) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.getSubagentTrace, toolCallId),
  setAgentsPanelVisible: (visible) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.setAgentsPanelVisible, visible),
  setWorkspacePanelWidth: (width) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.setWorkspacePanelWidth, width),
  setTheme: (theme) => ipcRenderer.invoke(DESKTOP_CHANNELS.setTheme, theme),
  setLanguage: (language) => ipcRenderer.invoke(DESKTOP_CHANNELS.setLanguage, language),
  setThinkingVisible: (visible) => ipcRenderer.invoke(DESKTOP_CHANNELS.setThinkingVisible, visible),
  setLocalThinking: (model, level) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.setLocalThinking, model, level),
  setPermissionMode: (mode) => ipcRenderer.invoke(DESKTOP_CHANNELS.setPermissionMode, mode),
  setFastServing: (fast) => ipcRenderer.invoke(DESKTOP_CHANNELS.setFastServing, fast),
  openFireworksKeyPage: () => ipcRenderer.invoke(DESKTOP_CHANNELS.openFireworksKeyPage),
  setFireworksApiKey: (apiKey) => ipcRenderer.invoke(DESKTOP_CHANNELS.setFireworksApiKey, apiKey),
  connectLocalServers: (endpoints) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.connectLocalServers, endpoints),
  deleteLocalModel: (id) => ipcRenderer.invoke(DESKTOP_CHANNELS.deleteLocalModel, id),
  setDebugMode: (enabled) => ipcRenderer.invoke(DESKTOP_CHANNELS.setDebugMode, enabled),
  checkForUpdates: () => ipcRenderer.invoke(DESKTOP_CHANNELS.checkForUpdates),
  installUpdate: () => ipcRenderer.invoke(DESKTOP_CHANNELS.installUpdate),
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
