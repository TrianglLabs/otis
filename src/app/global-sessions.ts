import { basename } from "node:path"
import { isCanvasArtifact } from "../artifacts/canvas.js"
import type { ArtifactKind, PublishedArtifactReference } from "../artifacts/types.js"
import { digestAllSessions, listAllSessions, searchAllSessions } from "../storage/session.js"
import { type OpenSession, type SessionPickerItem, toSessionPickerItem } from "./sessions.js"

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
   * The sessions open in this process, by full (dirName, id) identity — ids repeat across storage
   * dirs, so both parts must match. Shown rows read as `active`.
   */
  open?: readonly OpenSession[]
  /** Workspace candidates for recovering pre-registration dirs (typically the current one). */
  seeds?: string[]
}

/** A Canvas document published by a tool in any workspace's session, at its latest version. */
export type RecentArtifact = {
  reference: PublishedArtifactReference
  name: string
  kind: ArtifactKind
  sessionId: string
  dirName: string
  workspaceLabel: string
  updatedAt: string
}

/** Unregistered dirs: strip the content hash suffix for a readable stand-in label. */
function workspaceLabel(dirName: string, workspacePath?: string) {
  return workspacePath
    ? basename(workspacePath) || workspacePath
    : dirName.replace(/-[0-9a-f]{12}$/, "") || dirName
}

function toGlobalItem(
  summary: { dirName: string; workspacePath?: string } & Parameters<typeof toSessionPickerItem>[0],
  options: GlobalOptions,
  snippet?: string,
): GlobalSessionPickerItem {
  const { dirName, workspacePath } = summary
  const open = options.open?.find((entry) => entry.id === summary.id && entry.dirName === dirName)
  return {
    ...toSessionPickerItem(summary, open),
    ...(snippet !== undefined ? { snippet } : {}),
    dirName,
    workspaceLabel: workspaceLabel(dirName, workspacePath),
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

export type GlobalHistory = {
  sessions: GlobalSessionPickerItem[]
  /** The newest Canvas documents across every workspace, one per artifact at its latest version. */
  artifacts: RecentArtifact[]
}

/**
 * One scan of every workspace's sessions yields both the picker rows and the recent documents, so
 * a snapshot carries them together. Each document is timestamped by the turn that produced it
 * when that turn ended on disk, else by the session's last event.
 */
export async function listGlobalHistory(
  artifactLimit: number,
  options: GlobalOptions,
): Promise<GlobalHistory> {
  const sessions = await digestAllSessions(options.seeds)
  const summaries = sessions.map((session) => session.summary)
  const latest = new Map<string, RecentArtifact>()
  for (const { summary, artifacts } of sessions)
    for (const { reference, endedAt } of artifacts) {
      if (!isCanvasArtifact(reference.kind)) continue
      const row: RecentArtifact = {
        reference,
        name: reference.name,
        kind: reference.kind,
        sessionId: summary.id,
        dirName: summary.dirName,
        workspaceLabel: workspaceLabel(summary.dirName, summary.workspacePath),
        updatedAt: endedAt ?? summary.updatedAt,
      }
      const known = latest.get(reference.artifactId)
      if (!known || known.reference.version < reference.version)
        latest.set(reference.artifactId, row)
    }
  return {
    sessions: summaries.map((summary) => toGlobalItem(summary, options)),
    artifacts: [...latest.values()]
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, artifactLimit),
  }
}
