import { readdir, readFile, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { parseDocument } from "yaml"
import { describeError } from "../inference/errors.js"
import type { ToolResult } from "../tools/types.js"
import { bundledSkills, materializeBundledSkill } from "./bundled.js"

const SKILLS_DIRECTORY = join(".agents", "skills")
/**
 * Where other agents keep skills in the same format, read in place beside `.agents/skills`:
 * Claude Code, Cursor and Gemini CLI in a project, GitHub Copilot in `.github`; at home, the
 * same three plus Copilot's own folder. Codex shares `.agents/skills`. At each level these come
 * first, so a skill of the same name in `.agents/skills` wins.
 */
const OTHER_AGENT_SKILLS = [".claude", ".cursor", ".gemini", ".github"].map((dir) =>
  join(dir, "skills"),
)
const OTHER_AGENT_HOME_SKILLS = [".claude", ".cursor", ".gemini", ".copilot"].map((dir) =>
  join(dir, "skills"),
)
export const MAX_SKILL_FILE_BYTES = 1024 * 1024
const MAX_DESCRIPTION_LENGTH = 1024
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

export async function loadSkillCatalog(
  cwd: string,
  options: { home?: string; dataDirectory?: string; otherAgents?: boolean } = {},
): Promise<SkillCatalog> {
  // Home first, then every ancestor from the filesystem root down, so the nearest project
  // definition wins.
  const home = resolve(options.home ?? homedir())
  const others = options.otherAgents ?? true
  const sources = new Set([
    ...(others ? OTHER_AGENT_HOME_SKILLS.map((dir) => join(home, dir)) : []),
    join(home, SKILLS_DIRECTORY),
  ])
  const ancestors: string[] = []
  for (let current = resolve(cwd); ; current = dirname(current)) {
    ancestors.unshift(join(current, SKILLS_DIRECTORY))
    if (others) ancestors.unshift(...OTHER_AGENT_SKILLS.map((dir) => join(current, dir)))
    if (dirname(current) === current) break
  }
  for (const source of ancestors) sources.add(source)

  const skills = new Map(bundledSkills(options.dataDirectory).map((skill) => [skill.name, skill]))
  const problems: string[] = []
  for (const source of sources) {
    const entries = await readdir(source, { withFileTypes: true }).catch((error) => {
      if (isNotFound(error)) return []
      throw error
    })
    // A skill that fails to load is left out and named; one typo in a pack must not take the
    // rest, or the app, down with it.
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      try {
        const skill = await loadSkillPackage(join(source, entry.name))
        if (skill) skills.set(skill.name, skill)
      } catch (error) {
        problems.push(describeError(error))
      }
    }
  }
  const ordered = [...skills.values()].sort((left, right) => left.name.localeCompare(right.name))
  return { skills: ordered, byName: new Map(ordered.map((skill) => [skill.name, skill])), problems }
}

export function emptySkillCatalog(): SkillCatalog {
  return { skills: [], byName: new Map(), problems: [] }
}

export async function loadSkillPackage(directory: string): Promise<Skill | undefined> {
  const instructionsPath = join(directory, "SKILL.md")
  let contents: string
  try {
    if (!(await stat(directory)).isDirectory()) return undefined
    const instructionsStat = await stat(instructionsPath)
    if (!instructionsStat.isFile()) return undefined
    if (instructionsStat.size > MAX_SKILL_FILE_BYTES) {
      throw new Error(
        `Invalid skill ${instructionsPath}: SKILL.md exceeds ${MAX_SKILL_FILE_BYTES} bytes.`,
      )
    }
    contents = await readFile(instructionsPath, "utf8")
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }

  const root = await realpath(directory)
  const path = await realpath(instructionsPath)
  assertInside(
    root,
    path,
    `Invalid skill ${instructionsPath}: SKILL.md resolves outside its skill.`,
  )
  const match = FRONTMATTER.exec(contents)
  if (!match) throw new Error(`Invalid skill ${path}: closed YAML frontmatter is required.`)
  const document = parseDocument(match[1], { uniqueKeys: true })
  if (document.errors.length > 0)
    throw new Error(`Invalid skill ${path}: ${document.errors[0].message}`)
  const value = document.toJS() as unknown
  if (!isRecord(value)) throw new Error(`Invalid skill ${path}: frontmatter must be an object.`)
  const { name, description } = value
  // Cursor's suites title their skills ("Poteto Mode"); the directory's slug is the name.
  const slug = typeof name === "string" ? name.trim().toLowerCase().replace(/\s+/gu, "-") : ""
  if (slug.length > 64 || !SKILL_NAME.test(slug)) {
    throw new Error(`Invalid skill ${path}: name must be 1-64 letters, numbers, or hyphens.`)
  }
  if (slug !== basename(directory)) {
    throw new Error(
      `Invalid skill ${path}: name must match its parent directory (${basename(directory)}).`,
    )
  }
  if (
    typeof description !== "string" ||
    !description.trim() ||
    description.length > MAX_DESCRIPTION_LENGTH
  ) {
    throw new Error(
      `Invalid skill ${path}: description must be 1-${MAX_DESCRIPTION_LENGTH} characters.`,
    )
  }
  // Claude Code and Cursor's switches: a manual-only skill stays out of the model's offer and
  // is run by its /name; a model-only one is kept off the user's menu.
  const flag = (key: string) => {
    const raw = value[key]
    if (raw !== undefined && typeof raw !== "boolean")
      throw new Error(`Invalid skill ${path}: ${key} must be true or false.`)
    return raw
  }
  return {
    name: slug,
    description: description.trim(),
    root,
    instructionsPath: path,
    modelInvocable: flag("disable-model-invocation") !== true,
    userInvocable: flag("user-invocable") !== false,
  }
}

/** The instructions an invoked skill hands the model: SKILL.md without its frontmatter. */
export async function skillInstructions(skill: Skill): Promise<string> {
  if (skill.bundled) await materializeBundledSkill(skill)
  const contents = await readFile(skill.instructionsPath, "utf8")
  return contents.replace(FRONTMATTER, "").trim()
}

export function assertInside(root: string, target: string, message: string) {
  const nested = relative(root, target)
  if (nested !== "" && (nested.startsWith("..") || isAbsolute(nested))) throw new Error(message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNotFound(error: unknown) {
  return isRecord(error) && error.code === "ENOENT"
}

export async function readSkillResource(
  catalog: SkillCatalog,
  name: string,
  path = "SKILL.md",
): Promise<ToolResult> {
  const skill = catalog.byName.get(name)
  if (!skill) throw new Error(`Unknown skill: ${name}`)
  if (!path.trim() || isAbsolute(path))
    throw new Error("Skill resource path must be relative to the skill root.")

  const requested = resolve(skill.root, path)
  assertInside(skill.root, requested, `Skill resource is outside the skill root: ${requested}`)
  if (skill.bundled) await materializeBundledSkill(skill)
  const root = skill.bundled ? await realpath(skill.root) : skill.root
  const canonical = await realpath(requested)
  assertInside(root, canonical, `Skill resource is outside the skill root: ${canonical}`)
  const resourceStat = await stat(canonical)

  if (resourceStat.isDirectory()) {
    const entries = await readdir(canonical, { withFileTypes: true })
    return {
      title: `Read skill directory: ${canonical}`,
      output:
        entries
          .sort((left, right) => left.name.localeCompare(right.name))
          .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
          .join("\n") || "Directory is empty.",
    }
  }
  if (!resourceStat.isFile()) throw new Error(`Skill resource is not a regular file: ${canonical}`)

  const contents = await readFile(canonical)
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(contents)
  } catch {
    throw new Error("skill supports UTF-8 text resources only.")
  }
  return {
    title: `Read skill resource: ${canonical}`,
    output: path === "SKILL.md" ? `Skill root: ${root}\n\n${text}` : text,
  }
}

export type Skill = {
  name: string
  description: string
  root: string
  instructionsPath: string
  /** Offered to the model in its prompt; off for a skill marked `disable-model-invocation`. */
  modelInvocable: boolean
  /** Runnable by the user as `/name`; off for a skill marked `user-invocable: false`. */
  userInvocable: boolean
  /** Embedded first-party resources, materialized only when this skill is loaded. */
  bundled?: boolean
}

export type SkillCatalog = {
  skills: readonly Skill[]
  byName: ReadonlyMap<string, Skill>
  /** Why each skill that failed to load was left out, naming its SKILL.md. */
  problems: readonly string[]
}

export type ManagedSkill = { name: string; relativePath: string }
/** A skill the agent can load, and where it comes from: a Git collection Otis manages, or files. */
export type SkillSummary = {
  name: string
  description: string
  origin: "bundled" | "personal" | "project" | { collection: string }
  /** Switched off in settings: loaded, but not offered to the model. */
  hidden: boolean
  modelInvocable: boolean
  userInvocable: boolean
}

export type SkillsSummary = {
  skills: SkillSummary[]
  sources: ManagedSkillSource[]
  problems: readonly string[]
}

/** The identity an Agent Plugin declares in its root `plugin.json`. */
export type SkillPlugin = { name: string; version?: string; description?: string }
export type ManagedSkillSource = {
  id: string
  url: string
  /** Present when the installed folder is an Agent Plugin. */
  plugin?: SkillPlugin
  /** The folder of a repository that holds the skills, from a `…/tree/<ref>/<folder>` URL. */
  path?: string
  /** Absent on collections installed before it was recorded. */
  installedAt?: string
  skills: ManagedSkill[]
}
export type SkillManagerManifest = { version: 1; sources: ManagedSkillSource[] }
