import type { Dirent } from "node:fs"
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { defaultSessionDirectory, sessionRootDirectory } from "./session-files.js"

/**
 * Workspace registration for global session history. Session directories are named `<slug>-<hash(cwd)>` — the
 * path is not recoverable from the name — so every workspace that opens a session leaves a small marker. Older
 * directories without one are still listed globally; the GUI offers "Locate workspace" for those.
 */

const MARKER = "workspace.json"

/** Remembers which workspace a session directory belongs to. Private file, like the session files themselves. */
export async function registerWorkspacePath(sessionDir: string, workspacePath: string): Promise<void> {
  const dir = resolve(sessionDir)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, MARKER)
  const body = `${JSON.stringify({ path: resolve(workspacePath) })}\n`
  const tmp = join(dir, `.${MARKER}.${process.pid}.tmp`)
  await writeFile(tmp, body, { mode: 0o600 })
  await rename(tmp, file)
}

/** The registered workspace path for a session directory, undefined for pre-registration history. */
export async function readWorkspacePath(sessionDir: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(resolve(sessionDir), MARKER), "utf8"))
    if (typeof parsed === "object" && parsed !== null && "path" in parsed && typeof parsed.path === "string") {
      return parsed.path
    }
    return undefined
  } catch {
    return undefined
  }
}

export type WorkspaceSessionDir = {
  /** The session storage directory (absolute). */
  dir: string
  /** Its directory name under sessions/ — the disambiguator when session ids repeat across workspaces. */
  dirName: string
  /** The registered workspace path, when known. */
  workspacePath?: string
}

/**
 * Every session directory under the shared data root, with its registered workspace path when present.
 * Pre-registration dirs are recovered when possible: their names carry `hash(cwd)`, so any candidate folder —
 * the seeds, registered workspaces, and their ancestors — whose derived dir name matches
 * exactly is the workspace the sessions started in. Recovered paths are persisted as markers, so this runs once.
 */
export async function listWorkspaceSessionDirs(seeds: string[] = []): Promise<WorkspaceSessionDir[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(sessionRootDirectory(), { withFileTypes: true })
  } catch {
    return []
  }
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  const known = await Promise.all(
    dirs.map(async (dirName) => {
      const dir = join(sessionRootDirectory(), dirName)
      return { dir, dirName, workspacePath: await readWorkspacePath(dir) }
    }),
  )
  const registered = known.flatMap((entry) => (entry.workspacePath ? [entry.workspacePath] : []))
  const candidates = recoveryCandidates([...seeds, ...registered])
  const unmatched = known.filter((entry) => entry.workspacePath === undefined)
  if (unmatched.length > 0 && candidates.length > 0) {
    const names = new Map(candidates.map((candidate) => [basename(defaultSessionDirectory(candidate)), candidate]))
    await Promise.all(
      unmatched.map(async (entry) => {
        const match = names.get(entry.dirName)
        if (!match) return
        try {
          await registerWorkspacePath(entry.dir, match)
          entry.workspacePath = match
        } catch {
          // Recovery is best-effort; an unwritable dir stays unregistered and is offered for location.
        }
      }),
    )
  }
  return known
}

/** Recovery candidates: each seed and its ancestors — pure path hashing, depth-capped, stopping at the root. */
function recoveryCandidates(seeds: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const seed of seeds) {
    let dir = resolve(seed)
    for (let depth = 0; depth < 8; depth += 1) {
      if (seen.has(dir)) break
      seen.add(dir)
      out.push(dir)
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return out
}
