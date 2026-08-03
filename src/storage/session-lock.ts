import { randomUUID } from "node:crypto"
import { chmod, mkdir, open, readFile, rm, stat } from "node:fs/promises"
import { dirname } from "node:path"
import { assertSessionId, sessionFile } from "./session-files.js"
import type { SessionOptions } from "./session-types.js"

export type SessionLock = { release(): Promise<void> }

/** Prevents multiple Otis processes from appending turns to the same session. */
export async function acquireSessionLock(
  options: Omit<SessionOptions, "sessionId"> & { sessionId: string },
): Promise<SessionLock> {
  assertSessionId(options.sessionId)
  const lockPath = `${sessionFile(options, options.sessionId)}.lock`
  const token = randomUUID()
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 })
  if (process.platform !== "win32") await chmod(dirname(lockPath), 0o700)

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600)
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token }), "utf8")
        await handle.sync()
      } finally {
        await handle.close()
      }
      return {
        async release() {
          if ((await lockToken(lockPath)) === token) await rm(lockPath, { force: true })
        },
      }
    } catch (error) {
      if (!isAlreadyExists(error)) throw error
      const owner = await lockOwner(lockPath)
      if (owner !== undefined && processIsAlive(owner)) {
        throw new Error(`Session ${options.sessionId} is already in use by process ${owner}.`)
      }
      if (owner === undefined && !(await lockIsStale(lockPath))) {
        throw new Error(`Session ${options.sessionId} is already being locked by another process.`)
      }
      await rm(lockPath, { force: true })
    }
  }

  throw new Error(`Could not acquire session ${options.sessionId}.`)
}

async function lockIsStale(path: string) {
  try {
    return Date.now() - (await stat(path)).mtimeMs >= 30_000
  } catch {
    return true
  }
}

async function lockOwner(path: string) {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown
    if (isRecord(value) && typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0) {
      return value.pid
    }
  } catch {
    // The caller checks the file age before treating malformed or partial content as stale.
  }
  return undefined
}

async function lockToken(path: string) {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown
    return isRecord(value) && typeof value.token === "string" ? value.token : undefined
  } catch {
    return undefined
  }
}

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return isPermissionError(error)
  }
}

function isAlreadyExists(error: unknown) {
  return isNodeError(error) && error.code === "EEXIST"
}

function isPermissionError(error: unknown) {
  return isNodeError(error) && error.code === "EPERM"
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
