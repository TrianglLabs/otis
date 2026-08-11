import { randomUUID } from "node:crypto"
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { requiredString, validSourceId } from "./managed-source.js"
import type { ManagedSkill, ManagedSkillSource, SkillManagerManifest } from "./managed-types.js"
import { ensurePrivateDirectory } from "./manager-lock.js"

export const MANIFEST_VERSION = 1
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

export async function readManagedSkillsManifest(root: string): Promise<SkillManagerManifest> {
  const path = join(root, "manifest.json")
  let contents: string
  try {
    contents = await readFile(path, "utf8")
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { version: MANIFEST_VERSION, sources: [] }
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(contents)
  } catch (error) {
    throw new Error(`Invalid managed skills manifest: ${error instanceof Error ? error.message : String(error)}`)
  }
  return parseManifest(value)
}

export async function writeManagedSkillsManifest(root: string, manifest: SkillManagerManifest) {
  await ensurePrivateDirectory(root)
  const path = join(root, "manifest.json")
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
    if (process.platform !== "win32") await chmod(temporary, 0o600)
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

export function sortedSources(sources: ManagedSkillSource[]) {
  return [...sources].sort((left, right) => left.id.localeCompare(right.id))
}

function parseManifest(value: unknown): SkillManagerManifest {
  if (!isRecord(value) || value.version !== MANIFEST_VERSION || !Array.isArray(value.sources)) {
    throw new Error("Invalid managed skills manifest: expected version 1 with a sources array.")
  }
  const sourceIds = new Set<string>()
  const skillNames = new Set<string>()
  const sources = value.sources.map((rawSource, sourceIndex): ManagedSkillSource => {
    if (!isRecord(rawSource)) throw new Error(`Invalid managed skills manifest: sources[${sourceIndex}] is invalid.`)
    const id = validSourceId(rawSource.id, `sources[${sourceIndex}].id`)
    if (sourceIds.has(id)) throw new Error(`Invalid managed skills manifest: duplicate source ${id}.`)
    sourceIds.add(id)
    const url = requiredString(rawSource.url, `sources[${sourceIndex}].url`)
    if (!Array.isArray(rawSource.skills)) {
      throw new Error(`Invalid managed skills manifest: sources[${sourceIndex}].skills must be an array.`)
    }
    const skills = rawSource.skills.map((rawSkill, skillIndex): ManagedSkill => {
      if (!isRecord(rawSkill)) throw new Error(`Invalid managed skills manifest: skill ${skillIndex} is invalid.`)
      const name = requiredString(rawSkill.name, `sources[${sourceIndex}].skills[${skillIndex}].name`)
      if (!SKILL_NAME.test(name)) throw new Error(`Invalid managed skills manifest: invalid skill name ${name}.`)
      if (skillNames.has(name)) throw new Error(`Invalid managed skills manifest: duplicate skill ${name}.`)
      skillNames.add(name)
      const relativePath = requiredString(
        rawSkill.relativePath,
        `sources[${sourceIndex}].skills[${skillIndex}].relativePath`,
      )
      if (isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes("..")) {
        throw new Error(`Invalid managed skills manifest: unsafe skill path ${relativePath}.`)
      }
      return { name, relativePath }
    })
    return { id, url, skills: skills.sort((left, right) => left.name.localeCompare(right.name)) }
  })
  return { version: MANIFEST_VERSION, sources: sortedSources(sources) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}
