import { basename } from "node:path"
import { listAllSessions, searchAllSessions } from "../storage/index.js"
import { type SessionPickerItem, toSessionPickerItem } from "./session-metadata.js"

/**
 * Global session history for the desktop palette: sessions from every workspace under the shared data root.
 * Identity is (dirName, id) — ids repeat across workspaces ("default" is common), so opening a session from
 * another workspace needs both. Rows whose workspace path is unknown (history predating registration) are
 * still listed; the GUI offers "Locate workspace" for them.
 */
export type GlobalSessionPickerItem = SessionPickerItem & {
  dirName: string
  workspaceLabel: string
  workspacePath?: string
}

function workspaceLabelFor(dirName: string, workspacePath: string | undefined) {
  if (workspacePath) return basename(workspacePath) || workspacePath
  // Unregistered dirs: strip the content hash suffix for a readable stand-in label.
  return dirName.replace(/-[0-9a-f]{12}$/, "") || dirName
}

type GlobalOptions = {
  /** Full identity of the active session; ids repeat across storage dirs, so both parts must match. */
  activeId?: string
  activeDirName?: string
  /** Workspace candidates for recovering pre-registration dirs (the current workspace, typically). */
  seeds?: string[]
}

function toGlobalItem(
  summary: { dirName: string; workspacePath?: string } & Parameters<typeof toSessionPickerItem>[0],
  options: GlobalOptions,
  snippet?: string,
): GlobalSessionPickerItem {
  const item = toSessionPickerItem(summary, undefined)
  const active = options.activeId === summary.id && options.activeDirName === summary.dirName
  return {
    ...item,
    ...(active ? { active: true } : {}),
    ...(snippet !== undefined ? { snippet } : {}),
    dirName: summary.dirName,
    workspaceLabel: workspaceLabelFor(summary.dirName, summary.workspacePath),
    ...(summary.workspacePath !== undefined ? { workspacePath: summary.workspacePath } : {}),
  }
}

export async function listGlobalSessionPickerItems(options: GlobalOptions): Promise<GlobalSessionPickerItem[]> {
  const summaries = await listAllSessions({ seeds: options.seeds })
  return summaries.map((summary) => toGlobalItem(summary, options))
}

/** Title-first search across all workspaces; content hits carry a snippet. */
export async function searchGlobalSessionPickerItems(
  query: string,
  options: GlobalOptions,
): Promise<GlobalSessionPickerItem[]> {
  const results = await searchAllSessions(query, { seeds: options.seeds })
  return results.map((result) => toGlobalItem(result, options, result.snippet))
}
