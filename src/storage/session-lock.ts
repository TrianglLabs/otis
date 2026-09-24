import { randomUUID } from "node:crypto"
import { chmod, mkdir, open, readFile, rm, stat } from "node:fs/promises"
import { dirname } from "node:path"
import { assertSessionId, type SessionOptions, sessionFile } from "./session-files.js"

export type SessionLock = { release(): Promise<void> }

/**
 * Tokens this process currently holds. A lock file owned by our pid but with an unknown token is
 * a leftover from a released (or crashed-mid-flight) acquisition in this same process — reclaim
 * it instead of self-conflicting.
 */
const heldTokens = new Set<string>()

/** Another live Otis process holds the session; unlike an I/O failure, that is expected. */
export class SessionInUseError extends Error {}

/** Prevents multiple Otis processes from appending turns to the same session. */
export async function acquireSessionLock(
  options: Omit<SessionOptions, "sessionId"> & { sessionId: string },
): Promise<SessionLock> {
  assertSessionId(options.sessionId)
  const lockPath = `${sessionFile(options, options.sessionId)}.lock`
  const token = randomUUID()
  // Register before creating the file: a concurrent acquisition in this process must see this
  // token as held, never mistake the half-finished acquisition for a stale leftover and reclaim
  // it.
  heldTokens.add(token)
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 })
  if (process.platform !== "win32") await chmod(dirname(lockPath), 0o700)

  try {
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
            heldTokens.delete(token)
            if ((await readLockFile(lockPath))?.token === token) await rm(lockPath, { force: true })
          },
        }
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error
        const lock = await readLockFile(lockPath)
        const pid =
          lock && typeof lock.pid === "number" && Number.isSafeInteger(lock.pid) && lock.pid > 0
            ? lock.pid
            : 0
        if (pid) {
          let alive = typeof lock?.token === "string" && heldTokens.has(lock.token)
          if (pid !== process.pid) {
            try {
              process.kill(pid, 0)
              alive = true
            } catch (error) {
              alive = isNodeError(error) && error.code === "EPERM"
            }
          }
          if (alive)
            throw new SessionInUseError(
              `Session ${options.sessionId} is already in use by process ${pid}.`,
            )
        } else {
          // Malformed or partial content is only stale once the file has stopped changing for a
          // while.
          const modifiedAt = await stat(lockPath).then(
            (info) => info.mtimeMs,
            () => 0,
          )
          if (Date.now() - modifiedAt < 30_000)
            throw new SessionInUseError(
              `Session ${options.sessionId} is already being locked by another process.`,
            )
        }
        await rm(lockPath, { force: true })
      }
    }
  } catch (error) {
    heldTokens.delete(token)
    throw error
  }

  heldTokens.delete(token)
  throw new Error(`Could not acquire session ${options.sessionId}.`)
}

async function readLockFile(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"))
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}
