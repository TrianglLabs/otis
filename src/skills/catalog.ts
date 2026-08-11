import type { Dirent, Stats } from "node:fs"
import { readdir, readFile, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { parseDocument } from "yaml"
import type { Skill, SkillCatalog } from "./types.js"

const SKILLS_DIRECTORY = join(".agents", "skills")
const SKILL_FILENAME = "SKILL.md"
const MAX_SKILL_FILE_BYTES = 1024 * 1024
const MAX_DESCRIPTION_LENGTH = 1024
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

export async function loadSkillCatalog(cwd: string, options: { home?: string } = {}): Promise<SkillCatalog> {
  const skills = new Map<string, Skill>()
  for (const source of skillSources(cwd, options.home)) {
    for (const skill of await loadSkillsFromDirectory(source)) skills.set(skill.name, skill)
  }

  const ordered = [...skills.values()].sort((left, right) => left.name.localeCompare(right.name))
  return { skills: ordered, byName: new Map(ordered.map((skill) => [skill.name, skill])) }
}

export function emptySkillCatalog(): SkillCatalog {
  return { skills: [], byName: new Map() }
}

async function loadSkillsFromDirectory(directory: string): Promise<Skill[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (isNotFound(error)) return []
    throw error
  }

  const skills: Skill[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const skill = await loadSkillPackage(join(directory, entry.name))
    if (skill) skills.push(skill)
  }
  return skills
}

export async function loadSkillPackage(directory: string): Promise<Skill | undefined> {
  let directoryStat: Stats
  try {
    directoryStat = await stat(directory)
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
  if (!directoryStat.isDirectory()) return undefined

  const instructionsPath = join(directory, SKILL_FILENAME)
  let contents: string
  try {
    const instructionsStat = await stat(instructionsPath)
    if (!instructionsStat.isFile()) return undefined
    if (instructionsStat.size > MAX_SKILL_FILE_BYTES) {
      throw new Error(`Invalid skill ${instructionsPath}: SKILL.md exceeds ${MAX_SKILL_FILE_BYTES} bytes.`)
    }
    contents = await readFile(instructionsPath, "utf8")
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }

  const root = await realpath(directory)
  const canonicalInstructions = await realpath(instructionsPath)
  assertInside(root, canonicalInstructions, `Invalid skill ${instructionsPath}: SKILL.md resolves outside its skill.`)
  return parseSkill(contents, root, canonicalInstructions, basename(directory))
}

function parseSkill(contents: string, root: string, instructionsPath: string, directoryName: string): Skill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(contents)
  if (!match) throw new Error(`Invalid skill ${instructionsPath}: closed YAML frontmatter is required.`)

  const document = parseDocument(match[1], { uniqueKeys: true })
  if (document.errors.length > 0) {
    throw new Error(`Invalid skill ${instructionsPath}: ${document.errors[0]?.message ?? "invalid YAML frontmatter"}`)
  }
  const value = document.toJS() as unknown
  if (!isRecord(value)) throw new Error(`Invalid skill ${instructionsPath}: frontmatter must be an object.`)
  const name = value.name
  const description = value.description
  if (typeof name !== "string" || name.length > 64 || !SKILL_NAME.test(name)) {
    throw new Error(`Invalid skill ${instructionsPath}: name must be 1-64 lowercase letters, numbers, or hyphens.`)
  }
  if (name !== directoryName) {
    throw new Error(`Invalid skill ${instructionsPath}: name must match its parent directory (${directoryName}).`)
  }
  if (typeof description !== "string" || !description.trim() || description.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`Invalid skill ${instructionsPath}: description must be 1-${MAX_DESCRIPTION_LENGTH} characters.`)
  }
  return { name, description: description.trim(), root, instructionsPath }
}

function skillSources(cwd: string, homeOverride?: string) {
  const sources: string[] = []
  const seen = new Set<string>()
  addSource(join(resolve(homeOverride ?? homedir()), SKILLS_DIRECTORY), sources, seen)

  const ancestors: string[] = []
  let current = resolve(cwd)
  while (true) {
    ancestors.unshift(join(current, SKILLS_DIRECTORY))
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  for (const source of ancestors) addSource(source, sources, seen)
  return sources
}

function addSource(source: string, sources: string[], seen: Set<string>) {
  const resolved = resolve(source)
  if (seen.has(resolved)) return
  seen.add(resolved)
  sources.push(resolved)
}

function assertInside(root: string, target: string, message: string) {
  const nested = relative(root, target)
  if (nested === "" || (!nested.startsWith("..") && !isAbsolute(nested))) return
  throw new Error(message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNotFound(error: unknown) {
  return isRecord(error) && error.code === "ENOENT"
}
