import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron"
import { DESKTOP_CHANNELS, type DesktopApi, type DesktopEvent, type DesktopWindowState } from "../contracts.js"

const api: DesktopApi = {
  getSnapshot: () => ipcRenderer.invoke(DESKTOP_CHANNELS.getSnapshot),
  getArtifact: (revision) => ipcRenderer.invoke(DESKTOP_CHANNELS.getArtifact, revision),
  openArtifact: (reference, version) => ipcRenderer.invoke(DESKTOP_CHANNELS.openArtifact, reference, version),
  saveArtifact: (id, revision) => ipcRenderer.invoke(DESKTOP_CHANNELS.saveArtifact, id, revision),
  getWindowState: () => ipcRenderer.invoke(DESKTOP_CHANNELS.getWindowState),
  sendPrompt: (text, attachments) => ipcRenderer.invoke(DESKTOP_CHANNELS.sendPrompt, text, attachments),
  stop: () => ipcRenderer.invoke(DESKTOP_CHANNELS.stop),
  respondToPermission: (id, allow) => ipcRenderer.invoke(DESKTOP_CHANNELS.respondToPermission, id, allow),
  selectSession: (id, dirName) => ipcRenderer.invoke(DESKTOP_CHANNELS.selectSession, id, dirName),
  searchSessions: (query) => ipcRenderer.invoke(DESKTOP_CHANNELS.searchSessions, query),
  startNewSession: () => ipcRenderer.invoke(DESKTOP_CHANNELS.startNewSession),
  openSessionAt: (workspacePath, sessionId, dirName) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.openSessionAt, workspacePath, sessionId, dirName),
  openWorkspace: (path) => ipcRenderer.invoke(DESKTOP_CHANNELS.openWorkspace, path),
  locateWorkspace: (path) => ipcRenderer.invoke(DESKTOP_CHANNELS.locateWorkspace, path),
  pickWorkspaceFolder: () => ipcRenderer.invoke(DESKTOP_CHANNELS.pickWorkspaceFolder),
  registerWorkspace: (dirName, path) => ipcRenderer.invoke(DESKTOP_CHANNELS.registerWorkspace, dirName, path),
  deleteSession: (id, dirName) => ipcRenderer.invoke(DESKTOP_CHANNELS.deleteSession, id, dirName),
  refreshSessions: () => ipcRenderer.invoke(DESKTOP_CHANNELS.refreshSessions),
  listModels: () => ipcRenderer.invoke(DESKTOP_CHANNELS.listModels),
  selectModel: (id) => ipcRenderer.invoke(DESKTOP_CHANNELS.selectModel, id),
  cancelModelSelection: () => ipcRenderer.invoke(DESKTOP_CHANNELS.cancelModelSelection),
  getSubagentTrace: (toolCallId: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.getSubagentTrace, toolCallId),
  setAgentsPanelVisible: (visible: boolean) => ipcRenderer.invoke(DESKTOP_CHANNELS.setAgentsPanelVisible, visible),
  setTheme: (theme: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.setTheme, theme),
  setLanguage: (language: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.setLanguage, language),
  setThinkingVisible: (visible: boolean) => ipcRenderer.invoke(DESKTOP_CHANNELS.setThinkingVisible, visible),
  setLocalThinking: (model, level) => ipcRenderer.invoke(DESKTOP_CHANNELS.setLocalThinking, model, level),
  setPermissionMode: (mode: "ask" | "auto") => ipcRenderer.invoke(DESKTOP_CHANNELS.setPermissionMode, mode),
  setFastServing: (fast: boolean) => ipcRenderer.invoke(DESKTOP_CHANNELS.setFastServing, fast),
  openFireworksKeyPage: () => ipcRenderer.invoke(DESKTOP_CHANNELS.openFireworksKeyPage),
  setFireworksApiKey: (apiKey: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.setFireworksApiKey, apiKey),
  connectLocalServers: (endpoints: import("../../app/local-servers.js").LocalServerInputs) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.connectLocalServers, endpoints),
  deleteLocalModel: (id: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.deleteLocalModel, id),
  setDebugMode: (enabled: boolean) => ipcRenderer.invoke(DESKTOP_CHANNELS.setDebugMode, enabled),
  checkForUpdates: () => ipcRenderer.invoke(DESKTOP_CHANNELS.checkForUpdates),
  installUpdate: () => ipcRenderer.invoke(DESKTOP_CHANNELS.installUpdate),
  subscribeWindowState: (listener) => {
    const wrapped = (_event: IpcRendererEvent, state: DesktopWindowState) => listener(state)
    ipcRenderer.on(DESKTOP_CHANNELS.windowState, wrapped)
    return () => {
      ipcRenderer.removeListener(DESKTOP_CHANNELS.windowState, wrapped)
    }
  },
  subscribe: (listener) => {
    const wrapped = (_event: IpcRendererEvent, payload: DesktopEvent) => listener(payload)
    ipcRenderer.on(DESKTOP_CHANNELS.event, wrapped)
    return () => {
      ipcRenderer.removeListener(DESKTOP_CHANNELS.event, wrapped)
    }
  },
}

contextBridge.exposeInMainWorld("otis", api)
