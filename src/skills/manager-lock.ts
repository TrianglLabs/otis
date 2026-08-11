import { randomUUID } from "node:crypto"
import { chmod, mkdir, open, readFile, rm, stat } from "node:fs/promises"
import { join } from "node:path"

const LOCK_STALE_MS = 30_000

export async function acquireSkillManagerLock(root: string) {
  await ensurePrivateDirectory(root)
  const path = join(root, "manager.lock")
  const token = randomUUID()
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600)
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token }), "utf8")
        await handle.sync()
      } finally {
        await handle.close()
      }
      return {
        async release() {
          if ((await lockToken(path)) === token) await rm(path, { force: true })
        },
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error
      const owner = await lockOwner(path)
      if (owner !== undefined && processIsAlive(owner)) {
        throw new Error(`Another Otis skill operation is running in process ${owner}.`)
      }
      if (owner === undefined && !(await lockIsStale(path))) {
        throw new Error("Another Otis skill operation is starting.")
      }
      await rm(path, { force: true })
    }
  }
  throw new Error("Could not acquire the Otis skill manager lock.")
}

export async function ensurePrivateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  if (process.platform !== "win32") await chmod(path, 0o700)
}

async function lockOwner(path: string) {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown
    if (isRecord(value) && typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0) {
      return value.pid
    }
  } catch {
    // A partial lock is treated as live until it ages past the stale threshold.
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

async function lockIsStale(path: string) {
  try {
    return Date.now() - (await stat(path)).mtimeMs >= LOCK_STALE_MS
  } catch {
    return true
  }
}

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM"
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}
