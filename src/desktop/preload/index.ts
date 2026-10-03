import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron"
import { DESKTOP_CHANNELS, type DesktopApi } from "../contracts.js"

/** Electron reports a rejection as "Error invoking remote method '…': Error: <reason>". */
const invoke = (channel: string, ...args: unknown[]) =>
  ipcRenderer.invoke(channel, ...args).catch((error: Error) => {
    throw new Error(
      error.message.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, ""),
    )
  })

/** A main-to-renderer stream as a subscription that returns its unsubscribe. */
function listen<T>(channel: string, listener: (payload: T) => void) {
  const wrapped = (_event: IpcRendererEvent, payload: T) => listener(payload)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

const api: DesktopApi = {
  getSnapshot: () => invoke(DESKTOP_CHANNELS.getSnapshot),
  getArtifact: (runtime, id, revision) =>
    invoke(DESKTOP_CHANNELS.getArtifact, runtime, id, revision),
  getArtifactAsset: (runtime, id, revision, src) =>
    invoke(DESKTOP_CHANNELS.getArtifactAsset, runtime, id, revision, src),
  closeArtifact: (runtime, id) => invoke(DESKTOP_CHANNELS.closeArtifact, runtime, id),
  openArtifact: (reference, version, runtime) =>
    invoke(DESKTOP_CHANNELS.openArtifact, reference, version, runtime),
  saveArtifact: (runtime, id, revision) =>
    invoke(DESKTOP_CHANNELS.saveArtifact, runtime, id, revision),
  getWindowState: () => invoke(DESKTOP_CHANNELS.getWindowState),
  sendPrompt: (text, attachments) => invoke(DESKTOP_CHANNELS.sendPrompt, text, attachments),
  stop: () => invoke(DESKTOP_CHANNELS.stop),
  respondToPermission: (id, allow) => invoke(DESKTOP_CHANNELS.respondToPermission, id, allow),
  selectSession: (id, dirName, at) => invoke(DESKTOP_CHANNELS.selectSession, id, dirName, at),
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
  listHostedCatalogs: () => invoke(DESKTOP_CHANNELS.listHostedCatalogs),
  setModelHidden: (provider, id, hidden) =>
    invoke(DESKTOP_CHANNELS.setModelHidden, provider, id, hidden),
  setPrimeTeamId: (teamId) => invoke(DESKTOP_CHANNELS.setPrimeTeamId, teamId),
  selectModel: (id) => invoke(DESKTOP_CHANNELS.selectModel, id),
  cancelModelSelection: () => invoke(DESKTOP_CHANNELS.cancelModelSelection),
  getSubagentTrace: (toolCallId) => invoke(DESKTOP_CHANNELS.getSubagentTrace, toolCallId),
  setAgentsPanelVisible: (visible) => invoke(DESKTOP_CHANNELS.setAgentsPanelVisible, visible),
  setWorkspacePanelWidth: (width) => invoke(DESKTOP_CHANNELS.setWorkspacePanelWidth, width),
  markAchievementsSeen: () => invoke(DESKTOP_CHANNELS.markAchievementsSeen),
  listMemory: () => invoke(DESKTOP_CHANNELS.listMemory),
  rememberFact: (scope, fact) => invoke(DESKTOP_CHANNELS.rememberFact, scope, fact),
  forgetFact: (scope, fact) => invoke(DESKTOP_CHANNELS.forgetFact, scope, fact),
  setTheme: (theme) => invoke(DESKTOP_CHANNELS.setTheme, theme),
  setTextSize: (textSize) => invoke(DESKTOP_CHANNELS.setTextSize, textSize),
  setLanguage: (language) => invoke(DESKTOP_CHANNELS.setLanguage, language),
  setThinkingVisible: (visible) => invoke(DESKTOP_CHANNELS.setThinkingVisible, visible),
  setNotifyOnCompletion: (enabled) => invoke(DESKTOP_CHANNELS.setNotifyOnCompletion, enabled),
  setLocalThinking: (model, level) => invoke(DESKTOP_CHANNELS.setLocalThinking, model, level),
  setPermissionMode: (mode) => invoke(DESKTOP_CHANNELS.setPermissionMode, mode),
  setFastServing: (fast) => invoke(DESKTOP_CHANNELS.setFastServing, fast),
  openHostedKeyPage: (provider) => invoke(DESKTOP_CHANNELS.openHostedKeyPage, provider),
  setHostedApiKey: (provider, apiKey) => invoke(DESKTOP_CHANNELS.setHostedApiKey, provider, apiKey),
  connectLocalServers: (endpoints) => invoke(DESKTOP_CHANNELS.connectLocalServers, endpoints),
  deleteLocalModel: (id) => invoke(DESKTOP_CHANNELS.deleteLocalModel, id),
  listSkills: () => invoke(DESKTOP_CHANNELS.listSkills),
  installSkills: (url) => invoke(DESKTOP_CHANNELS.installSkills, url),
  updateSkills: (id) => invoke(DESKTOP_CHANNELS.updateSkills, id),
  removeSkills: (id) => invoke(DESKTOP_CHANNELS.removeSkills, id),
  setDebugMode: (enabled) => invoke(DESKTOP_CHANNELS.setDebugMode, enabled),
  checkForUpdates: () => invoke(DESKTOP_CHANNELS.checkForUpdates),
  installUpdate: () => invoke(DESKTOP_CHANNELS.installUpdate),
  openTerminal: () => invoke(DESKTOP_CHANNELS.openTerminal),
  writeTerminal: (data) => invoke(DESKTOP_CHANNELS.writeTerminal, data),
  resizeTerminal: (cols, rows) => invoke(DESKTOP_CHANNELS.resizeTerminal, cols, rows),
  closeTerminal: () => invoke(DESKTOP_CHANNELS.closeTerminal),
  subscribeTerminal: (listener) => listen(DESKTOP_CHANNELS.terminal, listener),
  subscribeWindowState: (listener) => listen(DESKTOP_CHANNELS.windowState, listener),
  subscribe: (listener) => listen(DESKTOP_CHANNELS.event, listener),
}

contextBridge.exposeInMainWorld("otis", api)
