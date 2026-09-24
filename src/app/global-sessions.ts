import { basename, join } from "node:path"
import { isCanvasArtifact } from "../artifacts/canvas.js"
import {
  type ArtifactKind,
  isPublishedArtifactReference,
  type PublishedArtifactReference,
} from "../artifacts/types.js"
import { listAllSessions, searchAllSessions } from "../storage/session.js"
import { readSessionEvents, replaySessionTranscript } from "../storage/session-events.js"
import { sessionRootDirectory } from "../storage/session-files.js"
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
   * dirs, so both parts must match. Focused rows read as `active`.
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
  const summaries = await listAllSessions({ seeds: options.seeds })
  const latest = new Map<string, RecentArtifact>()
  for (const summary of summaries) {
    let events: Awaited<ReturnType<typeof readSessionEvents>>
    try {
      events = await readSessionEvents(
        join(sessionRootDirectory(), summary.dirName, `${summary.id}.jsonl`),
      )
    } catch {
      continue // listed a moment ago; a file that vanished or broke since is not a home-screen row
    }
    // Activities archived at a compaction checkpoint end with their prompt's turn event.
    const endedAt = new Map<string, string>()
    const archived = new Map<string, string[]>()
    for (const event of events) {
      if (event.type === "compacted" && event.promptId && event.turn?.toolActivities) {
        const ids = event.turn.toolActivities.map((activity) => activity.toolCallId)
        archived.set(event.promptId, [...(archived.get(event.promptId) ?? []), ...ids])
      } else if (event.type === "turn_completed" || event.type === "turn_interrupted") {
        const ids = (event.toolActivities ?? []).map((activity) => activity.toolCallId)
        for (const id of [...(archived.get(event.promptId) ?? []), ...ids])
          endedAt.set(id, event.at)
      }
    }
    for (const activity of replaySessionTranscript(events).toolActivities) {
      const reference = activity.artifact
      if (!isPublishedArtifactReference(reference) || !isCanvasArtifact(reference.kind)) continue
      const row: RecentArtifact = {
        reference,
        name: reference.name,
        kind: reference.kind,
        sessionId: summary.id,
        dirName: summary.dirName,
        workspaceLabel: workspaceLabel(summary.dirName, summary.workspacePath),
        updatedAt: endedAt.get(activity.toolCallId) ?? summary.updatedAt,
      }
      const known = latest.get(reference.artifactId)
      if (!known || known.reference.version < reference.version)
        latest.set(reference.artifactId, row)
    }
  }
  return {
    sessions: summaries.map((summary) => toGlobalItem(summary, options)),
    artifacts: [...latest.values()]
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, artifactLimit),
  }
}
