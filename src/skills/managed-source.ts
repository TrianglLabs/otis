import type { Dirent } from "node:fs"
import { readdir, realpath } from "node:fs/promises"
import { basename, isAbsolute, join, relative } from "node:path"
import { loadSkillPackage } from "./catalog.js"
import type { ManagedSkill } from "./managed-types.js"

const SOURCE_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u

export async function discoverManagedSkills(sourceDirectory: string): Promise<ManagedSkill[]> {
  const canonicalSource = await realpath(sourceDirectory)
  const candidates = [sourceDirectory]
  for (const collection of [join(sourceDirectory, "skills"), join(sourceDirectory, ".agents", "skills")]) {
    let entries: Dirent[]
    try {
      entries = await readdir(collection, { withFileTypes: true })
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue
      throw error
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isDirectory() || entry.isSymbolicLink()) candidates.push(join(collection, entry.name))
    }
  }

  const skills = new Map<string, ManagedSkill>()
  for (const candidate of candidates) {
    const skill = await loadSkillPackage(candidate)
    if (!skill) continue
    assertInside(canonicalSource, skill.root, `Skill resolves outside its managed source: ${skill.name}`)
    if (skills.has(skill.name)) throw new Error(`Managed source contains duplicate skill name: ${skill.name}`)
    skills.set(skill.name, { name: skill.name, relativePath: relative(canonicalSource, skill.root) || "." })
  }
  return [...skills.values()].sort((left, right) => left.name.localeCompare(right.name))
}

export function sourceIdFromURL(url: string) {
  const path = url.replace(/[\\/]+$/u, "")
  const repository = basename(path.split(":").at(-1) ?? path)
    .replace(/\.git$/iu, "")
    .toLowerCase()
  const normalized = repository.replace(/[^a-z0-9._-]+/gu, "-").replace(/^[._-]+|[._-]+$/gu, "")
  if (!normalized) throw new Error("Could not derive a skill source name; pass --name.")
  return validSourceId(normalized)
}

export function requiredGitURL(value: string) {
  const url = requiredString(value, "Git URL")
  if (url.startsWith("-")) throw new Error("Git URL must not start with a hyphen.")
  return url
}

export function validSourceId(value: unknown, label = "Skill source name") {
  const id = requiredString(value, label)
  if (id.length > 64 || !SOURCE_ID.test(id)) {
    throw new Error(`${label} must be 1-64 lowercase letters, numbers, dots, underscores, or hyphens.`)
  }
  return id
}

export function requiredString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`)
  return value.trim()
}

function assertInside(root: string, target: string, message: string) {
  const nested = relative(root, target)
  if (nested === "" || (!nested.startsWith("..") && !isAbsolute(nested))) return
  throw new Error(message)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}
