import { appendFile, mkdir, readdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join, sep } from "node:path"
import type { MemoryIndex } from "../inference/types.js"
import { localDataDirectory } from "../local/paths.js"
import { runGit } from "../skills/manager.js"
import { searchAllSessions, searchNeedles } from "../storage/session.js"
import { defaultSessionDirectory } from "../storage/session-files.js"

export type MemoryScope = MemoryIndex["scope"]

export function isMemoryScope(value: unknown): value is MemoryScope {
  return value === "workspace" || value === "global"
}

export type MemoryEntry = {
  scope: MemoryScope
  /** The topic file the fact lives in, as its `[[link]]` path. */
  topic: string
  /** The day it was remembered; absent on lines written by hand. */
  date?: string
  text: string
}

const SCOPES = ["workspace", "global"] as const
const DEFAULT_TOPIC = "general"
const INDEX = "MEMORY.md"
/**
 * The Agent Memory Repo layout: `MEMORY.md` indexes topic files with `[[path]]` links, and a
 * fact is one bullet with optional `[key: value; key: value]` metadata, `source` and `added`.
 */
const ENTRY = /^- (.+?)(?: \[((?:source|added): [^\]]*)\])?$/u
/** `- 2026-09-27 [session]: fact`, the single-file layout before 0.2.19. */
const LEGACY_ENTRY = /^- (?:(\d{4}-\d{2}-\d{2})(?: \[([^\]]+)\])?: )?(.+)$/u

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

/** A topic as the agent or user typed it, normalized to a `[[link]]` path. */
export function memoryTopic(value: string | undefined) {
  const topic = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.md$/u, "")
    .replace(/[\s_]+/gu, "-")
    .replace(/[^a-z0-9/-]+/gu, "")
    .replace(/-{2,}/gu, "-")
    .replace(/-?\/+-?/gu, "/")
    .replace(/^[-/]+|[-/]+$/gu, "")
  if (topic) return topic
  if (value?.trim()) throw new Error(`"${value}" is not a usable topic name.`)
  return DEFAULT_TOPIC
}

/**
 * The memory folder of a scope. Facts remembered before 0.2.19 sat in one `memory.md` beside
 * it (and in 0.2.6, in the project's `.otis/`); they move into the folder on first use.
 */
async function memoryRoot(scope: MemoryScope, cwd: string) {
  const parent = scope === "global" ? localDataDirectory() : defaultSessionDirectory(cwd)
  const root = join(parent, "memory")
  const legacy = [
    join(parent, "memory.md"),
    ...(scope === "global" ? [] : [join(cwd, ".otis", "memory.md")]),
  ]
  for (const file of legacy) {
    const old = await readFile(file, "utf8").catch(() => undefined)
    if (old === undefined) continue
    const facts = old.split("\n").flatMap((line) => {
      const match = LEGACY_ENTRY.exec(line)
      return match ? [formatEntry(match[3], match[2], match[1])] : []
    })
    if (facts.length) await appendEntries(root, scope, cwd, DEFAULT_TOPIC, facts)
    await rm(file)
    if (file.startsWith(join(cwd, ".otis"))) await rmdir(dirname(file)).catch(() => {})
  }
  return root
}

function formatEntry(text: string, source?: string, added?: string) {
  const metadata = [source && `source: ${source}`, added && `added: ${added}`].filter(Boolean)
  return `- ${text}${metadata.length ? ` [${metadata.join("; ")}]` : ""}`
}

function parseEntry(scope: MemoryScope, topic: string, line: string): MemoryEntry | undefined {
  const match = ENTRY.exec(line)
  if (!match) return undefined
  const added = /(?:^|;)\s*added:\s*(\d{4}-\d{2}-\d{2})/u.exec(match[2] ?? "")?.[1]
  return { scope, topic, ...(added ? { date: added } : {}), text: match[1] }
}

/** Every topic file, nested ones too; dot folders such as `.git` and the index are not topics. */
async function topicFiles(root: string) {
  const names = await readdir(root, { recursive: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[]
    throw error
  })
  return names
    .map((name) => name.split(sep))
    .filter(
      (parts) =>
        parts.at(-1)?.endsWith(".md") &&
        parts.at(-1) !== INDEX &&
        !parts.some((part) => part.startsWith(".")),
    )
    .map((parts) => ({ topic: parts.join("/").slice(0, -3), file: join(root, ...parts) }))
    .sort((a, b) => (a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0))
}

async function readLines(file: string) {
  const content = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return ""
    throw error
  })
  return content ? content.replace(/\n$/u, "").split("\n") : []
}

/** Appends facts to a topic file, creating it with a heading and linking it from the index. */
async function appendEntries(
  root: string,
  scope: MemoryScope,
  cwd: string,
  topic: string,
  lines: string[],
) {
  const file = join(root, `${topic}.md`)
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const content = await readFile(file, "utf8").catch(() => "")
  const name = topic.slice(topic.lastIndexOf("/") + 1).replace(/[-_]+/gu, " ")
  const heading = `# ${name.charAt(0).toUpperCase()}${name.slice(1)}\n\n`
  const head = content ? (content.endsWith("\n") ? "" : "\n") : heading
  // Appending keeps a fact another session saves at the same moment.
  await appendFile(file, `${head}${lines.map((line) => `${line}\n`).join("")}`, { mode: 0o600 })
  // A link the user wrote by hand, annotated or not, is the same link.
  const index = join(root, INDEX)
  const indexLines = await readLines(index)
  if (indexLines.some((line) => line.includes(`[[${topic}]]`))) return
  const owner = scope === "global" ? "Otis" : basename(cwd) || "workspace"
  const existing = indexLines.length ? indexLines : [`# Memory: ${owner}`, ""]
  await writeFile(index, `${[...existing, `- [[${topic}]]`].join("\n")}\n`, { mode: 0o600 })
}

/**
 * When the memory folder is itself a git repository, every change becomes a commit there, so
 * the history is the user's and syncs through whatever remote they gave the repository. Otis
 * never pushes. A repository further up, say a home directory under version control, is left
 * alone. Returns the short hash, or nothing when the folder is not a repository.
 */
async function commitMemory(root: string, message: string) {
  const repository = await stat(join(root, ".git")).then(
    () => true,
    () => false,
  )
  if (!repository) return undefined
  try {
    await runGit(["add", "--all"], { cwd: root })
    await runGit(["commit", "--quiet", "--message", message], { cwd: root })
  } catch (error) {
    // The fact is on disk; the caller must not save it again.
    throw new Error(`Saved, but the memory repository commit failed: ${(error as Error).message}`)
  }
  return (await runGit(["rev-parse", "--short", "HEAD"], { cwd: root })).trim()
}

/**
 * Each scope's `MEMORY.md` as it is on disk, for the system prompt: the entry point the Agent
 * Memory Repo layout keeps short, so the model knows the topics before it asks. Scopes without
 * one are left out.
 */
export async function memoryIndex(cwd: string): Promise<MemoryIndex[]> {
  const indexes = await Promise.all(
    SCOPES.map(async (scope) => {
      const content = await readFile(join(await memoryRoot(scope, cwd), INDEX), "utf8").catch(
        () => "",
      )
      return content.trim() ? [{ scope, content }] : []
    }),
  )
  return indexes.flat()
}

export async function listMemory(cwd: string): Promise<MemoryEntry[]> {
  const entries = await Promise.all(
    SCOPES.map(async (scope) => {
      const root = await memoryRoot(scope, cwd)
      const topics = await topicFiles(root)
      const rows = await Promise.all(
        topics.map(async ({ topic, file }) =>
          (await readLines(file)).flatMap((line) => {
            const entry = parseEntry(scope, topic, line)
            return entry ? [entry] : []
          }),
        ),
      )
      return rows.flat()
    }),
  )
  return entries.flat()
}

export async function remember(
  scope: MemoryScope,
  fact: string,
  cwd: string,
  session?: string,
  topic = DEFAULT_TOPIC,
): Promise<MemoryEntry & { commit?: string }> {
  const { entries, commit } = await rememberAll(scope, [{ topic, text: fact }], cwd, session)
  if (!entries[0]) throw new Error("There is nothing to remember.")
  return { ...entries[0], ...(commit ? { commit } : {}) }
}

/**
 * Remembers several facts at once, each in its topic, with one commit; blank facts are skipped.
 * `source` names where they came from: a session, or another agent.
 */
export async function rememberAll(
  scope: MemoryScope,
  facts: readonly { topic?: string; text: string }[],
  cwd: string,
  source?: string,
): Promise<{ entries: MemoryEntry[]; commit?: string }> {
  const date = new Date().toISOString().slice(0, 10)
  const entries: MemoryEntry[] = []
  const byTopic = new Map<string, string[]>()
  for (const fact of facts) {
    const text = redactPrivate(fact.text.trim().replace(/\s+/gu, " "))
    if (!text) continue
    const topic = fact.topic ?? DEFAULT_TOPIC
    byTopic.set(topic, [...(byTopic.get(topic) ?? []), formatEntry(text, source, date)])
    entries.push({ scope, topic, date, text })
  }
  if (!entries.length) return { entries }
  const root = await memoryRoot(scope, cwd)
  for (const [topic, lines] of byTopic) await appendEntries(root, scope, cwd, topic, lines)
  const commit = await commitMemory(root, `memory: remember ${[...byTopic.keys()].join(", ")}`)
  return { entries, ...(commit ? { commit } : {}) }
}

/** Removes the entry whose text matches, or the one entry containing the given text. */
export async function forget(
  scope: MemoryScope,
  fact: string,
  cwd: string,
): Promise<MemoryEntry & { commit?: string }> {
  const needle = fact.trim().toLowerCase()
  const root = await memoryRoot(scope, cwd)
  const found: { topic: string; file: string; lines: string[]; index: number; text: string }[] = []
  for (const { topic, file } of await topicFiles(root)) {
    const lines = await readLines(file)
    lines.forEach((line, index) => {
      const entry = parseEntry(scope, topic, line)
      if (entry) found.push({ topic, file, lines, index, text: entry.text.toLowerCase() })
    })
  }
  const exact = found.filter((hit) => hit.text === needle)
  const candidates = exact.length ? exact : found.filter((hit) => hit.text.includes(needle))
  if (candidates.length !== 1)
    throw new Error(
      candidates.length === 0
        ? `Nothing in ${scope} memory matches "${fact.trim()}".`
        : `"${fact.trim()}" matches ${candidates.length} ${scope} memories; pass the full text.`,
    )
  const [{ topic, file, lines, index }] = candidates
  const entry = parseEntry(scope, topic, lines[index]) as MemoryEntry
  const kept = lines.filter((_, at) => at !== index)
  if (kept.some((line) => ENTRY.test(line))) {
    await writeFile(file, kept.map((line) => `${line}\n`).join(""), { mode: 0o600 })
  } else {
    // A topic without facts leaves, with its folder when that empties too, and its index link.
    await rm(file)
    await rmdir(dirname(file)).catch(() => {})
    const indexFile = join(root, INDEX)
    const indexLines = (await readLines(indexFile)).filter((line) => !line.includes(`[[${topic}]]`))
    await writeFile(indexFile, indexLines.map((line) => `${line}\n`).join(""), { mode: 0o600 })
  }
  const commit = await commitMemory(root, `memory: forget ${topic}`)
  return { ...entry, ...(commit ? { commit } : {}) }
}

/**
 * What memory and past sessions know about a query, by its words: the facts any word matches,
 * most words first, a topic's name counting as one of them so the index's topics read whole;
 * then transcript hits across every workspace, never the session asking. All of it passes
 * redaction.
 */
export async function recall(query: string, cwd: string, session?: string): Promise<string> {
  const needles = searchNeedles(query, true)
  const memories = (await listMemory(cwd))
    .map((memory) => ({
      memory,
      score: needles.filter((needle) => needle.test(`${memory.topic} ${memory.text}`)).length,
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .map(({ memory }) => memory)
  const sections = SCOPES.flatMap((scope) => {
    const rows = memories
      .filter((memory) => memory.scope === scope)
      .map((memory) => `- ${memory.text} (${memory.topic}${memory.date ? `, ${memory.date}` : ""})`)
    return rows.length ? [`Remembered (${scope}):\n${rows.join("\n")}`] : []
  })
  const sessions = (await searchAllSessions(query, { seeds: [cwd], words: true }))
    .filter((hit) => hit.id !== session)
    .slice(0, 8)
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
