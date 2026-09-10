import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron"
import { DESKTOP_CHANNELS, type DesktopApi, type DesktopEvent } from "../contracts.js"

const api: DesktopApi = {
  getSnapshot: () => ipcRenderer.invoke(DESKTOP_CHANNELS.getSnapshot),
  sendPrompt: (text) => ipcRenderer.invoke(DESKTOP_CHANNELS.sendPrompt, text),
  stop: () => ipcRenderer.invoke(DESKTOP_CHANNELS.stop),
  respondToPermission: (id, allow) => ipcRenderer.invoke(DESKTOP_CHANNELS.respondToPermission, id, allow),
  selectSession: (id) => ipcRenderer.invoke(DESKTOP_CHANNELS.selectSession, id),
  searchSessions: (query) => ipcRenderer.invoke(DESKTOP_CHANNELS.searchSessions, query),
  startNewSession: () => ipcRenderer.invoke(DESKTOP_CHANNELS.startNewSession),
  deleteSession: (id) => ipcRenderer.invoke(DESKTOP_CHANNELS.deleteSession, id),
  listModels: () => ipcRenderer.invoke(DESKTOP_CHANNELS.listModels),
  selectModel: (id) => ipcRenderer.invoke(DESKTOP_CHANNELS.selectModel, id),
  cancelModelSelection: () => ipcRenderer.invoke(DESKTOP_CHANNELS.cancelModelSelection),
  getSubagentTrace: (toolCallId: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.getSubagentTrace, toolCallId),
  setAgentsPanelVisible: (visible: boolean) => ipcRenderer.invoke(DESKTOP_CHANNELS.setAgentsPanelVisible, visible),
  setTheme: (theme: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.setTheme, theme),
  setThinkingVisible: (visible: boolean) => ipcRenderer.invoke(DESKTOP_CHANNELS.setThinkingVisible, visible),
  setFastServing: (fast: boolean) => ipcRenderer.invoke(DESKTOP_CHANNELS.setFastServing, fast),
  openFireworksKeyPage: () => ipcRenderer.invoke(DESKTOP_CHANNELS.openFireworksKeyPage),
  setFireworksApiKey: (apiKey: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.setFireworksApiKey, apiKey),
  connectPairEndpoints: (endpoints: { ollama?: string; lmStudio?: string }) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.connectPairEndpoints, endpoints),
  listDownloadedModels: () => ipcRenderer.invoke(DESKTOP_CHANNELS.listDownloadedModels),
  deleteLocalModel: (id: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.deleteLocalModel, id),
  setDebugMode: (enabled: boolean) => ipcRenderer.invoke(DESKTOP_CHANNELS.setDebugMode, enabled),
  subscribe: (listener) => {
    const wrapped = (_event: IpcRendererEvent, payload: DesktopEvent) => listener(payload)
    ipcRenderer.on(DESKTOP_CHANNELS.event, wrapped)
    return () => {
      ipcRenderer.removeListener(DESKTOP_CHANNELS.event, wrapped)
    }
  },
}

contextBridge.exposeInMainWorld("otis", api)
