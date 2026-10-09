import { readdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import {
  OTHER_AGENTS,
  type OtherAgentId,
  otherAgentHomes,
  otherAgentInstructionFiles,
} from "../core/context.js"
import { listMemory, type MemoryScope, redactPrivate, rememberAll } from "../memory/memory.js"

/** A fact as Otis would remember it: its text after redaction, where, and whether it already is. */
export type OtherAgentFact = { scope: MemoryScope; topic: string; text: string; imported: boolean }

/** What one agent on this machine holds that Otis can take over, for the folder it was asked about. */
export type OtherAgentImport = {
  id: OtherAgentId
  name: string
  /** The agent's global instruction file, when it has content. */
  instructions?: { path: string; text: string; imported: boolean }
  facts: OtherAgentFact[]
}

export type OtherAgentPicks = { instructions: boolean; facts: string[] }

const GEMINI_MEMORIES = "## Gemini Added Memories"
/** The sections of Codex's memory summary that hold facts, and the topics they land in. */
const CODEX_SECTIONS = {
  "## User preferences": "codex/preferences",
  "## General Tips": "codex/tips",
}

/**
 * The agents on this machine with instructions or memory worth importing for `cwd`: their global
 * instruction file, and their memory as facts. Claude Code's memory is per project, so its facts
 * are for this workspace; Codex and Gemini keep one memory, so theirs are global. Nothing is
 * read from an agent that has neither.
 */
export async function listOtherAgents(
  cwd: string,
  env = process.env,
  home = env.HOME || homedir(),
): Promise<OtherAgentImport[]> {
  const homes = otherAgentHomes(env, home)
  const remembered = new Set(
    (await listMemory(cwd)).map((entry) => `${entry.scope}\n${entry.text}`),
  )
  const instructionsFile = await text(join(home, "AGENTS.md"))
  const agents: OtherAgentImport[] = []
  for (const id of Object.keys(OTHER_AGENTS) as OtherAgentId[]) {
    let instructions: { path: string; text: string } | undefined
    for (const file of otherAgentInstructionFiles(homes))
      if (file.agent === id && !instructions) {
        const content = await text(file.path)
        if (content.trim()) instructions = { path: file.path, text: content }
      }
    let facts: { scope: MemoryScope; topic: string; text: string }[]
    if (id === "claude-code") facts = await claudeMemory(homes[id], cwd)
    else if (id === "codex") {
      const summary = await text(join(homes[id], "memories", "memory_summary.md"))
      facts = Object.entries(CODEX_SECTIONS).flatMap(([section, topic]) =>
        bullets(summary, section).map((text) => ({ scope: "global" as const, topic, text })),
      )
    } else {
      // Gemini's saved memories live in its global instruction file; the rest is instructions.
      const memories = instructions ? bullets(instructions.text, GEMINI_MEMORIES) : []
      facts = memories.map((text) => ({ scope: "global" as const, topic: "gemini/memories", text }))
      const rest = instructions?.text.replace(section(instructions.text, GEMINI_MEMORIES), "")
      instructions = rest?.trim() && instructions ? { ...instructions, text: rest } : undefined
    }
    const prepared = facts.flatMap(({ scope, topic, text }) => {
      const redacted = redactPrivate(text.trim().replace(/\s+/gu, " "))
      if (!redacted) return []
      return [{ scope, topic, text: redacted, imported: remembered.has(`${scope}\n${redacted}`) }]
    })
    if (!instructions && !prepared.length) continue
    agents.push({
      id,
      name: OTHER_AGENTS[id],
      ...(instructions
        ? { instructions: { ...instructions, imported: instructionsFile.includes(heading(id)) } }
        : {}),
      facts: prepared,
    })
  }
  return agents
}

/**
 * Takes the picked items over: instructions into `~/AGENTS.md` under the agent's own heading,
 * replacing an earlier import of the same agent, and facts into memory marked with the agent as
 * their source. Facts already remembered are left alone. The other agent's files are not touched.
 */
export async function importOtherAgent(
  cwd: string,
  id: OtherAgentId,
  picks: OtherAgentPicks,
  env = process.env,
  home = env.HOME || homedir(),
): Promise<{ instructions: boolean; facts: number }> {
  const agent = (await listOtherAgents(cwd, env, home)).find((entry) => entry.id === id)
  const wanted = new Set(picks.facts)
  const facts = (agent?.facts ?? []).filter((fact) => wanted.has(fact.text) && !fact.imported)
  for (const scope of ["workspace", "global"] as const) {
    const batch = facts.filter((fact) => fact.scope === scope)
    if (batch.length) await rememberAll(scope, batch, cwd, id)
  }
  const instructions = picks.instructions ? agent?.instructions : undefined
  if (instructions) {
    const file = join(home, "AGENTS.md")
    const current = await text(file)
    const section = `${heading(id)}\n\n${instructions.text.trim()}\n`
    const start = current.indexOf(heading(id))
    const end = start < 0 ? -1 : current.indexOf("\n## ", start + heading(id).length)
    const updated =
      start < 0
        ? `${current.trimEnd()}${current.trim() ? "\n\n" : ""}${section}`
        : `${current.slice(0, start)}${section}${end < 0 ? "" : current.slice(end)}`
    await writeFile(file, updated, { mode: 0o600 })
  }
  return { instructions: instructions !== undefined, facts: facts.length }
}

const heading = (id: OtherAgentId) => `## From ${OTHER_AGENTS[id]}`

/**
 * Claude Code keeps one memory folder per repository, named after its root with every `/` and
 * `.` as `-`, so the folder for `cwd` is found by trying each ancestor. A topic file's
 * frontmatter description is its fact; its type names the topic.
 */
async function claudeMemory(agentHome: string, cwd: string) {
  for (let directory = resolve(cwd); ; directory = dirname(directory)) {
    const root = join(agentHome, "projects", directory.replace(/[/.]/gu, "-"), "memory")
    const names = await readdir(root).catch(() => undefined)
    if (!names) {
      if (dirname(directory) === directory) return []
      continue
    }
    const facts: { scope: MemoryScope; topic: string; text: string }[] = []
    for (const name of names.filter((n) => n.endsWith(".md") && n !== "MEMORY.md").sort()) {
      const content = await text(join(root, name))
      const frontmatter = /^---\n([\s\S]*?)\n---\n?/u.exec(content)
      const field = (key: string) =>
        new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "mu")
          .exec(frontmatter?.[1] ?? "")?.[1]
          ?.replace(/^(["'])(.*)\1$/u, "$2")
      const body = content.slice(frontmatter?.[0].length ?? 0)
      const fact = field("description") ?? body.split("\n").find((line) => line.trim())
      if (fact)
        facts.push({
          scope: "workspace",
          topic: `claude-code/${field("type") ?? "general"}`,
          text: fact,
        })
    }
    return facts
  }
}

/** A Markdown section from its heading to the next heading of the same or higher level. */
function section(markdown: string, heading: string) {
  const start = markdown.indexOf(`${heading}\n`)
  if (start < 0) return ""
  const level = /^#+/u.exec(heading)?.[0].length ?? 2
  const rest = markdown.slice(start + heading.length)
  const next = new RegExp(`\\n#{1,${level}} `, "u").exec(rest)
  return markdown.slice(start, start + heading.length + (next ? next.index + 1 : rest.length))
}

/** The top-level bullets of a section, each as one fact. */
function bullets(markdown: string, heading: string) {
  return section(markdown, heading)
    .split("\n")
    .flatMap((line) => (line.startsWith("- ") ? [line.slice(2)] : []))
}

const text = (path: string) => readFile(path, "utf8").catch(() => "")
