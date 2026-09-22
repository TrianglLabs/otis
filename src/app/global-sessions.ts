import { basename } from "node:path"
import { listAllSessions, searchAllSessions } from "../storage/index.js"
import { type SessionPickerItem, toSessionPickerItem } from "./sessions.js"

/**
 * Global session history for the desktop palette: sessions from every workspace under the shared
 * data root. Identity is (dirName, id) — ids repeat across workspaces ("default" is common), so
 * opening a session from another workspace needs both. Rows whose workspace path is unknown
 * (history predating registration) are still listed; the GUI offers "Locate workspace" for them.
 */
export type GlobalSessionPickerItem = SessionPickerItem & {
  dirName: string
  workspaceLabel: string
  workspacePath?: string
}

type GlobalOptions = {
  /**
   * Full identity of the active session; ids repeat across storage dirs, so both parts must
   * match.
   */
  activeId?: string
  activeDirName?: string
  /** Workspace candidates for recovering pre-registration dirs (typically the current one). */
  seeds?: string[]
}

function toGlobalItem(
  summary: { dirName: string; workspacePath?: string } & Parameters<typeof toSessionPickerItem>[0],
  options: GlobalOptions,
  snippet?: string,
): GlobalSessionPickerItem {
  const { dirName, workspacePath } = summary
  const active = options.activeId === summary.id && options.activeDirName === dirName
  return {
    ...toSessionPickerItem(summary, undefined),
    ...(active ? { active: true } : {}),
    ...(snippet !== undefined ? { snippet } : {}),
    dirName,
    // Unregistered dirs: strip the content hash suffix for a readable stand-in label.
    workspaceLabel: workspacePath
      ? basename(workspacePath) || workspacePath
      : dirName.replace(/-[0-9a-f]{12}$/, "") || dirName,
    ...(workspacePath !== undefined ? { workspacePath } : {}),
  }
}

export async function listGlobalSessionPickerItems(
  options: GlobalOptions,
): Promise<GlobalSessionPickerItem[]> {
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
