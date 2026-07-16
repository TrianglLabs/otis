import { createHash } from "node:crypto"
import { chmod, mkdir, open } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { localDataDirectory } from "../local/paths.js"
import type { SessionOptions } from "./session-types.js"

export function defaultSessionDirectory(cwd: string) {
  return join(sessionRootDirectory(), projectDirectoryName(cwd))
}

export function sessionRootDirectory() {
  return join(localDataDirectory(), "sessions")
}

export function sessionDirectory(options: Omit<SessionOptions, "sessionId">) {
  return options.directory ? resolve(options.directory) : defaultSessionDirectory(options.cwd)
}

export function sessionFile(options: SessionOptions, sessionId: string) {
  return join(sessionDirectory(options), `${sessionId}.jsonl`)
}

export function assertSessionId(sessionId: string) {
  if (sessionId.length > 128 || !/^[A-Za-z0-9._-]+$/.test(sessionId)) {
    throw new Error(`Invalid session ID: ${sessionId}`)
  }
}

export async function appendJsonLine(filePath: string, line: string) {
  const directory = dirname(filePath)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmodPrivate(directory, 0o700)

  const handle = await open(filePath, "a", 0o600)
  try {
    await handle.chmod(0o600)
    await handle.writeFile(`${line}\n`, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function projectDirectoryName(cwd: string) {
  const workspace = resolve(cwd)
  const hash = createHash("sha256").update(workspace).digest("hex").slice(0, 12)
  const slug = (basename(workspace) || "workspace")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
  return `${slug || "workspace"}-${hash}`
}

async function chmodPrivate(path: string, mode: number) {
  if (process.platform !== "win32") await chmod(path, mode)
}
