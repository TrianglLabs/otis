import { listSessions, searchSessions } from "./session.js"
import type { SessionSummary } from "./session-types.js"
import { listWorkspaceSessionDirs } from "./workspace-registry.js"

/**
 * Global session history: every workspace's sessions under the shared data root, merged and recency-ordered.
 * Rows carry the storage dir name (identity when ids repeat across workspaces) and the registered workspace path
 * when known — pre-registration history reports `workspacePath: undefined` so callers can offer location.
 */
export type GlobalSessionSummary = SessionSummary & {
  dirName: string
  workspacePath?: string
}

export type GlobalSessionSearchResult = GlobalSessionSummary & { snippet?: string }

function byRecency(left: GlobalSessionSummary, right: GlobalSessionSummary) {
  const updated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
  return updated || right.mtimeMs - left.mtimeMs
}

export async function listAllSessions(options: { seeds?: string[] } = {}): Promise<GlobalSessionSummary[]> {
  const dirs = await listWorkspaceSessionDirs(options.seeds)
  const grouped = await Promise.all(
    dirs.map(async ({ dir, dirName, workspacePath }) => {
      try {
        const summaries = await listSessions({ cwd: "", directory: dir })
        return summaries.map(
          (s): GlobalSessionSummary => ({ ...s, dirName, ...(workspacePath ? { workspacePath } : {}) }),
        )
      } catch {
        return [] // a corrupt or half-written dir must not sink the whole list
      }
    }),
  )
  return grouped.flat().sort(byRecency)
}

/** Title-first search across every workspace's sessions; same ranking as single-workspace search. */
export async function searchAllSessions(
  query: string,
  options: { seeds?: string[] } = {},
): Promise<GlobalSessionSearchResult[]> {
  const dirs = await listWorkspaceSessionDirs(options.seeds)
  const grouped = await Promise.all(
    dirs.map(async ({ dir, dirName, workspacePath }) => {
      try {
        const results = await searchSessions({ cwd: "", directory: dir }, query)
        return results.map(
          (s): GlobalSessionSearchResult => ({ ...s, dirName, ...(workspacePath ? { workspacePath } : {}) }),
        )
      } catch {
        return []
      }
    }),
  )
  // Title hits before content hits within each dir's results; keep that ordering after the merge.
  return grouped
    .flat()
    .sort((left, right) => byRecency(left, right))
    .sort((left, right) => Number(left.snippet !== undefined) - Number(right.snippet !== undefined))
}
