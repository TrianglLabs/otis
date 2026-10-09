import { readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { ContextFile } from "../inference/types.js"

/** The agents whose files Otis reads in place or imports: their ids and shown names. */
export const OTHER_AGENTS = {
  "claude-code": "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
} as const
export type OtherAgentId = keyof typeof OTHER_AGENTS
export const isOtherAgentId = (value: unknown): value is OtherAgentId =>
  typeof value === "string" && value in OTHER_AGENTS

/**
 * The same kind of instructions in the names other agents give them, read when a folder has no
 * AGENTS.md: Claude Code, Gemini CLI, GitHub Copilot, then Cursor's legacy file. Codex uses
 * AGENTS.md already. Rules scoped to paths (Cursor globs, Copilot applyTo) are not instructions
 * for the whole folder and stay out.
 */
const OTHER_AGENT_INSTRUCTIONS = [
  "CLAUDE.md",
  "GEMINI.md",
  join(".github", "copilot-instructions.md"),
  ".cursorrules",
]

/**
 * Each agent's config folder; Claude Code and Codex let the user move theirs. The home folder is
 * the environment's, as elsewhere in Otis, falling back to the account's.
 */
export function otherAgentHomes(
  env = process.env,
  home = env.HOME || homedir(),
): Record<OtherAgentId, string> {
  return {
    "claude-code": env.CLAUDE_CONFIG_DIR || join(home, ".claude"),
    codex: env.CODEX_HOME || join(home, ".codex"),
    gemini: join(home, ".gemini"),
  }
}

/** The agents' own global instruction files, in the order Otis would read them. */
export function otherAgentInstructionFiles(homes: Record<OtherAgentId, string>) {
  return [
    { agent: "claude-code" as const, path: join(homes["claude-code"], "CLAUDE.md") },
    { agent: "codex" as const, path: join(homes.codex, "AGENTS.override.md") },
    { agent: "codex" as const, path: join(homes.codex, "AGENTS.md") },
    { agent: "gemini" as const, path: join(homes.gemini, "GEMINI.md") },
  ]
}

/**
 * Loads AGENTS.md files from the working directory up to the filesystem root, ordered root-first
 * so the nearest file appears last and overrides broader ones. A global file in the user's home
 * directory is the broadest layer. With `otherAgents`, a folder without AGENTS.md is read through
 * another agent's instruction file instead, and the home layer falls back to the agents' own
 * global files.
 */
export function loadProjectContext(cwd: string, otherAgents = true): ContextFile[] {
  const files: ContextFile[] = []
  let directory = resolve(cwd)
  while (true) {
    files.unshift(...loadContextFiles(directory, otherAgents))
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  const home = process.env.HOME || process.env.USERPROFILE
  if (!home) return files
  let homeFiles = loadContextFiles(resolve(home), otherAgents)
  if (!homeFiles.length && otherAgents)
    for (const { path } of otherAgentInstructionFiles(otherAgentHomes(process.env, home))) {
      const file = readContextFile(path)
      if (file) {
        homeFiles = [file]
        break
      }
    }
  for (const file of homeFiles.reverse())
    if (!files.some((known) => known.path === file.path)) files.unshift(file)
  return files
}

function loadContextFiles(directory: string, otherAgents: boolean): ContextFile[] {
  const own = readContextFile(join(directory, "AGENTS.md"))
  if (own || !otherAgents) return own ? [own] : []
  for (const name of OTHER_AGENT_INSTRUCTIONS) {
    const file = readContextFile(join(directory, name))
    if (file) return [file]
  }
  // Cursor's project rules that apply to every request; path-scoped ones are left out.
  const rules = join(directory, ".cursor", "rules")
  let names: string[]
  try {
    names = readdirSync(rules, { recursive: true }) as string[]
  } catch {
    return []
  }
  return names
    .filter((name) => name.endsWith(".mdc"))
    .sort()
    .flatMap((name) => {
      const file = readContextFile(join(rules, name))
      const frontmatter = file && /^---\n([\s\S]*?)\n---\n?/u.exec(file.content)
      if (!file || !frontmatter || !/^alwaysApply:\s*true\s*$/mu.test(frontmatter[1])) return []
      return [{ path: file.path, content: file.content.slice(frontmatter[0].length) }]
    })
}

function readContextFile(path: string): ContextFile | undefined {
  try {
    const content = readFileSync(path, "utf8")
    return content.trim() ? { path, content } : undefined
  } catch {
    return undefined
  }
}
