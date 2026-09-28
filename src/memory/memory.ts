import { appendFile, mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { localDataDirectory } from "../local/paths.js"
import { searchAllSessions } from "../storage/session.js"
import { defaultSessionDirectory } from "../storage/session-files.js"

export type MemoryScope = "workspace" | "global"

export function isMemoryScope(value: unknown): value is MemoryScope {
  return value === "workspace" || value === "global"
}

export type MemoryEntry = {
  scope: MemoryScope
  /** The day it was remembered; absent on lines written by hand. */
  date?: string
  text: string
}

const SCOPES = ["workspace", "global"] as const
/** `- 2026-09-27 [session]: fact`; a bullet written by hand carries only the fact. */
const ENTRY = /^- (?:(\d{4}-\d{2}-\d{2})(?: \[[^\]]+\])?: )?(.+)$/u

/**
 * Credentials and personal details that slip into a fact or a transcript excerpt never reach
 * memory or the model: API keys and tokens, then email addresses, phone, card and national-id
 * numbers. Memory is for the project and the user's tooling, not for people.
 */
const PRIVATE = [
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}/gu,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/gu,
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/gu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gu,
  // Git remotes (git@host:owner/repo) and identifiers such as ids, epochs, and byte counts stay.
  /(?<![\w.+-])(?!git@)[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gu,
  /(?<![\d#])(?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]\d{3}[ .-]\d{4}\b/gu,
  /(?<![\d#])\+\d{1,3}(?:[ .-]?\d{2,4}){3,4}\b/gu,
  /(?<![\d#])(?:\d{4}[ -]?){3}\d{4}\b/gu,
  /\b\d{3}-\d{2}-\d{4}\b/gu,
]
const ASSIGNED_SECRET = /\b(api[_-]?key|token|secret|password)(\s*[:=]\s*)\S+/giu

export function redactPrivate(text: string) {
  return PRIVATE.reduce((result, pattern) => result.replace(pattern, "[redacted]"), text).replace(
    ASSIGNED_SECRET,
    "$1$2[redacted]",
  )
}

async function memoryFile(scope: MemoryScope, cwd: string) {
  if (scope === "global") return join(localDataDirectory(), "memory.md")
  const file = join(defaultSessionDirectory(cwd), "memory.md")
  // 0.2.6 kept workspace memory in the project's `.otis/memory.md`, where it ended up in commits;
  // it moves to the data folder on first use.
  const legacy = join(cwd, ".otis", "memory.md")
  const old = await readFile(legacy, "utf8").catch(() => undefined)
  if (old === undefined) return file
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, old, { flag: "wx", mode: 0o600 }).catch(() => {})
  await rm(legacy)
  await rmdir(dirname(legacy)).catch(() => {})
  return file
}

export async function listMemory(cwd: string): Promise<MemoryEntry[]> {
  const entries = await Promise.all(
    SCOPES.map(async (scope) =>
      (await readLines(await memoryFile(scope, cwd))).flatMap((line) => {
        const match = ENTRY.exec(line)
        return match ? [entry(scope, match)] : []
      }),
    ),
  )
  return entries.flat()
}

export async function remember(
  scope: MemoryScope,
  fact: string,
  cwd: string,
  session?: string,
): Promise<MemoryEntry> {
  const text = redactPrivate(fact.trim().replace(/\s+/gu, " "))
  if (!text) throw new Error("There is nothing to remember.")
  const date = new Date().toISOString().slice(0, 10)
  const file = await memoryFile(scope, cwd)
  const content = await readFile(file, "utf8").catch(() => "")
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  // Appending keeps a fact another session saves at the same moment.
  const separator = content && !content.endsWith("\n") ? "\n" : ""
  const stamp = session ? `${date} [${session}]` : date
  await appendFile(file, `${separator}- ${stamp}: ${text}\n`, { mode: 0o600 })
  return { scope, date, text }
}

/** Removes the entry whose text matches, or the one entry containing the given text. */
export async function forget(scope: MemoryScope, fact: string, cwd: string): Promise<MemoryEntry> {
  const needle = fact.trim().toLowerCase()
  const file = await memoryFile(scope, cwd)
  const lines = await readLines(file)
  const matches = lines.map((line) => ENTRY.exec(line))
  const indexes = (test: (text: string) => boolean) =>
    matches.flatMap((match, index) => (match && test(match[2].toLowerCase()) ? [index] : []))
  const exact = indexes((text) => text === needle)
  const candidates = exact.length ? exact : indexes((text) => text.includes(needle))
  if (candidates.length !== 1)
    throw new Error(
      candidates.length === 0
        ? `Nothing in ${scope} memory matches "${fact.trim()}".`
        : `"${fact.trim()}" matches ${candidates.length} ${scope} memories; pass the full text.`,
    )
  const [index] = candidates
  const kept = lines.filter((_, at) => at !== index)
  await writeFile(file, kept.map((line) => `${line}\n`).join(""), { mode: 0o600 })
  return entry(scope, matches[index] as RegExpExecArray)
}

/**
 * What memory and past sessions know about a phrase: matching facts, then transcript hits across
 * every workspace, newest first, never the session asking. All of it passes redaction.
 */
export async function recall(query: string, cwd: string, session?: string): Promise<string> {
  const phrase = query.trim().toLowerCase()
  const memories = (await listMemory(cwd)).filter(({ text }) => text.toLowerCase().includes(phrase))
  const sessions = (await searchAllSessions(query, { seeds: [cwd] }))
    .filter((hit) => hit.id !== session)
    .slice(0, 8)
  const sections = SCOPES.flatMap((scope) => {
    const rows = memories
      .filter((memory) => memory.scope === scope)
      .map((memory) => `- ${memory.date ? `${memory.date}: ` : ""}${memory.text}`)
    return rows.length ? [`Remembered (${scope}):\n${rows.join("\n")}`] : []
  })
  if (sessions.length)
    sections.push(
      `Past sessions:\n${sessions
        .map((hit) => {
          const where = `${hit.updatedAt.slice(0, 10)} · ${hit.title} (${hit.dirName})`
          return `- ${where}${hit.snippet ? `: ${hit.snippet}` : ""}`
        })
        .join("\n")}`,
    )
  return redactPrivate(sections.join("\n\n") || "Nothing remembered or recorded matches.")
}

function entry(scope: MemoryScope, [, date, text]: RegExpExecArray): MemoryEntry {
  return { scope, ...(date ? { date } : {}), text }
}

async function readLines(file: string) {
  const content = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return ""
    throw error
  })
  return content ? content.replace(/\n$/u, "").split("\n") : []
}
