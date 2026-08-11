import { randomUUID } from "node:crypto"
import { lstat, mkdir, readlink, rename, rm, stat, symlink } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { localDataDirectory } from "../local/paths.js"
import { type GitRunner, runGit } from "./git.js"
import {
  MANIFEST_VERSION,
  readManagedSkillsManifest,
  sortedSources,
  writeManagedSkillsManifest,
} from "./managed-manifest.js"
import { discoverManagedSkills, requiredGitURL, sourceIdFromURL, validSourceId } from "./managed-source.js"
import type { ManagedSkill, ManagedSkillSource, SkillManagerManifest } from "./managed-types.js"
import { acquireSkillManagerLock, ensurePrivateDirectory } from "./manager-lock.js"

export type SkillManagerOptions = {
  rootDirectory?: string
  activationDirectory?: string
  git?: GitRunner
}

export class SkillManager {
  readonly rootDirectory: string
  readonly activationDirectory: string
  readonly #git: GitRunner

  constructor(options: SkillManagerOptions = {}) {
    this.rootDirectory = resolve(options.rootDirectory ?? join(localDataDirectory(), "skills"))
    this.activationDirectory = resolve(options.activationDirectory ?? join(homedir(), ".agents", "skills"))
    this.#git = options.git ?? runGit
  }

  async list(): Promise<ManagedSkillSource[]> {
    return (await readManagedSkillsManifest(this.rootDirectory)).sources
  }

  async install(url: string, requestedId?: string): Promise<ManagedSkillSource> {
    const cleanURL = requiredGitURL(url)
    const id = requestedId ? validSourceId(requestedId) : sourceIdFromURL(cleanURL)
    return this.#withLock(async () => {
      const manifest = await readManagedSkillsManifest(this.rootDirectory)
      if (manifest.sources.some((source) => source.id === id)) {
        throw new Error(`Skill source is already installed: ${id}`)
      }

      const sourcesDirectory = join(this.rootDirectory, "sources")
      const finalSource = join(sourcesDirectory, id)
      if (await pathExists(finalSource)) {
        throw new Error(`Managed skill source directory already exists: ${finalSource}`)
      }
      await ensurePrivateDirectory(sourcesDirectory)
      const temporaryContainer = join(sourcesDirectory, `.${id}.${randomUUID()}.installing`)
      const temporarySource = join(temporaryContainer, id)
      const createdLinks: string[] = []
      let sourceMoved = false

      try {
        await mkdir(temporaryContainer, { mode: 0o700 })
        await this.#git(["clone", "--", cleanURL, temporarySource])
        const skills = await discoverManagedSkills(temporarySource)
        if (skills.length === 0) throw new Error(`No Agent Skills were found in ${cleanURL}.`)
        await this.#assertInstallCollisions(skills)

        await rename(temporarySource, finalSource)
        sourceMoved = true
        await rm(temporaryContainer, { recursive: true, force: true })
        for (const skill of skills) {
          const destination = this.#activationPath(skill.name)
          await symlink(join(finalSource, skill.relativePath), destination, "dir")
          createdLinks.push(destination)
        }

        const source = { id, url: cleanURL, skills }
        await writeManagedSkillsManifest(this.rootDirectory, {
          version: MANIFEST_VERSION,
          sources: sortedSources([...manifest.sources, source]),
        })
        return source
      } catch (error) {
        return rollback(error, [
          ...createdLinks.map((path) => () => rm(path, { force: true })),
          () => rm(sourceMoved ? finalSource : temporaryContainer, { recursive: true, force: true }),
        ])
      }
    })
  }

  async update(requestedId?: string): Promise<ManagedSkillSource[]> {
    const id = requestedId === undefined ? undefined : validSourceId(requestedId)
    return this.#withLock(async () => {
      let manifest = await readManagedSkillsManifest(this.rootDirectory)
      const selected = id ? manifest.sources.filter((source) => source.id === id) : manifest.sources
      if (id && selected.length === 0) throw new Error(`Skill source is not installed: ${id}`)
      if (selected.length === 0) return []

      const updated: ManagedSkillSource[] = []
      for (const source of selected) {
        const result = await this.#updateSource(source, manifest)
        manifest = result.manifest
        updated.push(result.source)
      }
      return updated
    })
  }

  async remove(requestedId: string): Promise<ManagedSkillSource> {
    const id = validSourceId(requestedId)
    return this.#withLock(async () => {
      const manifest = await readManagedSkillsManifest(this.rootDirectory)
      const source = manifest.sources.find((candidate) => candidate.id === id)
      if (!source) throw new Error(`Skill source is not installed: ${id}`)
      const sourceDirectory = this.#sourceDirectory(source.id)
      await this.#assertOwnedActivations(source)

      const removedLinks: Array<{ path: string; target: string }> = []
      const backup = join(this.rootDirectory, `.${source.id}.${randomUUID()}.removing`)
      let sourceMoved = false
      try {
        if (await pathExists(sourceDirectory)) {
          await rename(sourceDirectory, backup)
          sourceMoved = true
        }
        for (const skill of source.skills) {
          const path = this.#activationPath(skill.name)
          const target = await symlinkTarget(path)
          if (target === undefined) continue
          await rm(path)
          removedLinks.push({ path, target })
        }
        await writeManagedSkillsManifest(this.rootDirectory, {
          version: MANIFEST_VERSION,
          sources: manifest.sources.filter((candidate) => candidate.id !== source.id),
        })
      } catch (error) {
        return rollback(error, [
          ...(sourceMoved ? [() => rename(backup, sourceDirectory)] : []),
          ...removedLinks.map((link) => () => symlink(link.target, link.path, "dir")),
        ])
      }
      if (sourceMoved) await rm(backup, { recursive: true, force: true }).catch(() => undefined)
      return source
    })
  }

  async #updateSource(
    source: ManagedSkillSource,
    manifest: SkillManagerManifest,
  ): Promise<{ source: ManagedSkillSource; manifest: SkillManagerManifest }> {
    const sourceDirectory = this.#sourceDirectory(source.id)
    if (!(await pathExists(sourceDirectory))) throw new Error(`Managed skill source is missing: ${sourceDirectory}`)
    await this.#assertOwnedActivations(source)
    const previousCommit = (await this.#git(["rev-parse", "HEAD"], { cwd: sourceDirectory })).trim()
    if (!previousCommit) throw new Error(`Could not resolve the current Git commit for ${source.id}.`)

    let pulled = false
    const createdLinks: string[] = []
    const removedLinks: Array<{ path: string; target: string }> = []
    try {
      await this.#git(["pull", "--ff-only"], { cwd: sourceDirectory })
      pulled = true
      const skills = await discoverManagedSkills(sourceDirectory)
      if (skills.length === 0) throw new Error(`Updated source contains no Agent Skills: ${source.id}`)
      await this.#assertUpdateCollisions(source, skills)

      const previousByName = new Map(source.skills.map((skill) => [skill.name, skill]))
      const nextByName = new Map(skills.map((skill) => [skill.name, skill]))
      for (const previous of source.skills) {
        const next = nextByName.get(previous.name)
        if (next?.relativePath === previous.relativePath) continue
        const path = this.#activationPath(previous.name)
        const target = await symlinkTarget(path)
        if (target !== undefined) {
          await rm(path)
          removedLinks.push({ path, target })
        }
      }
      for (const next of skills) {
        const previous = previousByName.get(next.name)
        const path = this.#activationPath(next.name)
        if (previous?.relativePath === next.relativePath && (await pathExists(path, { includeBrokenSymlink: true }))) {
          continue
        }
        await symlink(join(sourceDirectory, next.relativePath), path, "dir")
        createdLinks.push(path)
      }

      const updatedSource = { ...source, skills }
      const nextManifest = {
        version: MANIFEST_VERSION,
        sources: sortedSources(
          manifest.sources.map((candidate) => (candidate.id === source.id ? updatedSource : candidate)),
        ),
      } as const
      await writeManagedSkillsManifest(this.rootDirectory, nextManifest)
      return { source: updatedSource, manifest: nextManifest }
    } catch (error) {
      return rollback(error, [
        ...(pulled
          ? [() => this.#git(["reset", "--hard", previousCommit], { cwd: sourceDirectory }).then(() => undefined)]
          : []),
        ...createdLinks.map((path) => () => rm(path, { force: true })),
        ...removedLinks.map((link) => () => symlink(link.target, link.path, "dir")),
      ])
    }
  }

  async #assertInstallCollisions(skills: ManagedSkill[]) {
    await ensurePrivateDirectory(this.activationDirectory)
    for (const skill of skills) {
      const path = this.#activationPath(skill.name)
      if (await pathExists(path, { includeBrokenSymlink: true })) {
        throw new Error(`Skill is already installed and is not managed by this source: ${skill.name}`)
      }
    }
  }

  async #assertUpdateCollisions(previous: ManagedSkillSource, next: ManagedSkill[]) {
    const previousNames = new Set(previous.skills.map((skill) => skill.name))
    for (const skill of next) {
      if (previousNames.has(skill.name)) continue
      if (await pathExists(this.#activationPath(skill.name), { includeBrokenSymlink: true })) {
        throw new Error(`Updated source conflicts with an existing skill: ${skill.name}`)
      }
    }
  }

  async #assertOwnedActivations(source: ManagedSkillSource) {
    const sourceDirectory = this.#sourceDirectory(source.id)
    for (const skill of source.skills) {
      const path = this.#activationPath(skill.name)
      const target = await symlinkTarget(path)
      if (target === undefined) continue
      if (resolve(dirname(path), target) !== resolve(sourceDirectory, skill.relativePath)) {
        throw new Error(`Refusing to modify skill activation not owned by Otis: ${skill.name}`)
      }
    }
  }

  #sourceDirectory(id: string) {
    return join(this.rootDirectory, "sources", id)
  }

  #activationPath(name: string) {
    return join(this.activationDirectory, name)
  }

  async #withLock<T>(operation: () => Promise<T>): Promise<T> {
    const lock = await acquireSkillManagerLock(this.rootDirectory)
    try {
      return await operation()
    } finally {
      await lock.release()
    }
  }
}

async function pathExists(path: string, options: { includeBrokenSymlink?: boolean } = {}) {
  try {
    if (options.includeBrokenSymlink) await lstat(path)
    else await stat(path)
    return true
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false
    throw error
  }
}

async function symlinkTarget(path: string) {
  try {
    const pathStat = await lstat(path)
    if (!pathStat.isSymbolicLink()) throw new Error(`Skill activation is not a symbolic link: ${path}`)
    return await readlink(path)
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined
    throw error
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

async function rollback(originalError: unknown, actions: Array<() => Promise<unknown>>): Promise<never> {
  const rollbackErrors: unknown[] = []
  for (const action of actions) {
    try {
      await action()
    } catch (error) {
      rollbackErrors.push(error)
    }
  }
  if (rollbackErrors.length > 0) {
    const message = originalError instanceof Error ? originalError.message : String(originalError)
    throw new AggregateError([originalError, ...rollbackErrors], `${message} Rollback was incomplete.`)
  }
  throw originalError
}
