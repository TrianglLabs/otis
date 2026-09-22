import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { childProcessEnvironment, localDataDirectory } from "../local/paths.js"
import {
  assertInside,
  loadSkillPackage,
  type ManagedSkill,
  type ManagedSkillSource,
  SKILL_NAME,
  type SkillManagerManifest,
} from "./catalog.js"

const MAX_GIT_OUTPUT = 32_000
const LOCK_STALE_MS = 30_000
const SOURCE_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u

export type GitRunner = (args: readonly string[], options?: { cwd?: string }) => Promise<string>

export const runGit: GitRunner = (args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn("git", [...args], {
      cwd: options.cwd,
      env: childProcessEnvironment(process.env),
      stdio: ["inherit", "pipe", "pipe"],
    })
    let output = ""
    const append = (chunk: unknown) => {
      output = `${output}${String(chunk)}`.slice(-MAX_GIT_OUTPUT)
    }
    child.stdout.on("data", append)
    child.stderr.on("data", append)
    child.on("error", (error) => reject(new Error(`Could not run git: ${error.message}`)))
    child.on("close", (code) => {
      if (code === 0) resolve(output)
      else
        reject(
          new Error(
            `Git command failed (${code ?? "unknown"}): ${output.trim() || args.join(" ")}`,
          ),
        )
    })
  })

type SkillManagerOptions = {
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
    this.activationDirectory = resolve(
      options.activationDirectory ?? join(homedir(), ".agents", "skills"),
    )
    this.#git = options.git ?? runGit
  }

  async list(): Promise<ManagedSkillSource[]> {
    return (await readManifest(this.rootDirectory)).sources
  }

  async install(url: string, requestedId?: string): Promise<ManagedSkillSource> {
    const cleanURL = requiredString(url, "Git URL")
    if (cleanURL.startsWith("-")) throw new Error("Git URL must not start with a hyphen.")
    let id: string
    if (requestedId) {
      id = validSourceId(requestedId)
    } else {
      const path = cleanURL.replace(/[\\/]+$/u, "")
      const repository = basename(path.split(":").at(-1) ?? path)
        .replace(/\.git$/iu, "")
        .toLowerCase()
      const normalized = repository.replace(/[^a-z0-9._-]+/gu, "-").replace(/^[._-]+|[._-]+$/gu, "")
      if (!normalized) throw new Error("Could not derive a skill source name; pass --name.")
      id = validSourceId(normalized)
    }
    return this.#withLock(async () => {
      const manifest = await readManifest(this.rootDirectory)
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
        await ensurePrivateDirectory(this.activationDirectory)
        for (const skill of skills) {
          if (await pathExists(this.#activationPath(skill.name), { includeBrokenSymlink: true })) {
            throw new Error(
              `Skill is already installed and is not managed by this source: ${skill.name}`,
            )
          }
        }

        await rename(temporarySource, finalSource)
        sourceMoved = true
        await rm(temporaryContainer, { recursive: true, force: true })
        for (const skill of skills) {
          const destination = this.#activationPath(skill.name)
          await symlink(join(finalSource, skill.relativePath), destination, "dir")
          createdLinks.push(destination)
        }

        const source = { id, url: cleanURL, skills }
        await writeManifest(this.rootDirectory, {
          version: 1,
          sources: sortedSources([...manifest.sources, source]),
        })
        return source
      } catch (error) {
        return rollback(error, [
          ...createdLinks.map((path) => () => rm(path, { force: true })),
          () =>
            rm(sourceMoved ? finalSource : temporaryContainer, { recursive: true, force: true }),
        ])
      }
    })
  }

  async update(requestedId?: string): Promise<ManagedSkillSource[]> {
    const id = requestedId === undefined ? undefined : validSourceId(requestedId)
    return this.#withLock(async () => {
      let manifest = await readManifest(this.rootDirectory)
      const selected = id ? manifest.sources.filter((source) => source.id === id) : manifest.sources
      if (id && selected.length === 0) throw new Error(`Skill source is not installed: ${id}`)

      const updated: ManagedSkillSource[] = []
      for (const source of selected) {
        const sourceDirectory = this.#sourceDirectory(source.id)
        if (!(await pathExists(sourceDirectory))) {
          throw new Error(`Managed skill source is missing: ${sourceDirectory}`)
        }
        await this.#assertOwnedActivations(source)
        const previousCommit = (
          await this.#git(["rev-parse", "HEAD"], { cwd: sourceDirectory })
        ).trim()
        if (!previousCommit)
          throw new Error(`Could not resolve the current Git commit for ${source.id}.`)

        let pulled = false
        const createdLinks: string[] = []
        const removedLinks: Array<{ path: string; target: string }> = []
        try {
          await this.#git(["pull", "--ff-only"], { cwd: sourceDirectory })
          pulled = true
          const skills = await discoverManagedSkills(sourceDirectory)
          if (skills.length === 0)
            throw new Error(`Updated source contains no Agent Skills: ${source.id}`)
          const previousByName = new Map(source.skills.map((skill) => [skill.name, skill]))
          const nextByName = new Map(skills.map((skill) => [skill.name, skill]))
          for (const skill of skills) {
            if (previousByName.has(skill.name)) continue
            if (
              await pathExists(this.#activationPath(skill.name), { includeBrokenSymlink: true })
            ) {
              throw new Error(`Updated source conflicts with an existing skill: ${skill.name}`)
            }
          }

          for (const previous of source.skills) {
            if (nextByName.get(previous.name)?.relativePath === previous.relativePath) continue
            const path = this.#activationPath(previous.name)
            const target = await symlinkTarget(path)
            if (target === undefined) continue
            await rm(path)
            removedLinks.push({ path, target })
          }
          for (const next of skills) {
            const path = this.#activationPath(next.name)
            if (
              previousByName.get(next.name)?.relativePath === next.relativePath &&
              (await pathExists(path, { includeBrokenSymlink: true }))
            ) {
              continue
            }
            await symlink(join(sourceDirectory, next.relativePath), path, "dir")
            createdLinks.push(path)
          }

          const updatedSource = { ...source, skills }
          manifest = {
            version: 1,
            sources: sortedSources(
              manifest.sources.map((candidate) =>
                candidate.id === source.id ? updatedSource : candidate,
              ),
            ),
          }
          await writeManifest(this.rootDirectory, manifest)
          updated.push(updatedSource)
        } catch (error) {
          await rollback(error, [
            ...(pulled
              ? [
                  () =>
                    this.#git(["reset", "--hard", previousCommit], { cwd: sourceDirectory }).then(
                      () => undefined,
                    ),
                ]
              : []),
            ...createdLinks.map((path) => () => rm(path, { force: true })),
            ...removedLinks.map((link) => () => symlink(link.target, link.path, "dir")),
          ])
        }
      }
      return updated
    })
  }

  async remove(requestedId: string): Promise<ManagedSkillSource> {
    const id = validSourceId(requestedId)
    return this.#withLock(async () => {
      const manifest = await readManifest(this.rootDirectory)
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
        await writeManifest(this.rootDirectory, {
          version: 1,
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
    await ensurePrivateDirectory(this.rootDirectory)
    const path = join(this.rootDirectory, "manager.lock")
    const token = randomUUID()
    for (let attempt = 0; ; attempt += 1) {
      try {
        const handle = await open(path, "wx", 0o600)
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, token }), "utf8")
          await handle.sync()
        } finally {
          await handle.close()
        }
        break
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error
        const owner = (await readLock(path))?.pid
        if (owner !== undefined) {
          let alive = true
          try {
            process.kill(owner, 0)
          } catch (error) {
            alive = isNodeError(error) && error.code === "EPERM"
          }
          if (alive) throw new Error(`Another Otis skill operation is running in process ${owner}.`)
        } else {
          const stale = await stat(path).then(
            (lock) => Date.now() - lock.mtimeMs >= LOCK_STALE_MS,
            () => true,
          )
          if (!stale) throw new Error("Another Otis skill operation is starting.")
        }
        await rm(path, { force: true })
        if (attempt === 1) throw new Error("Could not acquire the Otis skill manager lock.")
      }
    }
    try {
      return await operation()
    } finally {
      if ((await readLock(path))?.token === token) await rm(path, { force: true })
    }
  }
}

async function readLock(path: string) {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown
    if (!isRecord(value)) return undefined
    return {
      pid:
        typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0
          ? value.pid
          : undefined,
      token: typeof value.token === "string" ? value.token : undefined,
    }
  } catch {
    // A partial lock is treated as live until it ages past the stale threshold.
    return undefined
  }
}

async function readManifest(root: string): Promise<SkillManagerManifest> {
  let contents: string
  try {
    contents = await readFile(join(root, "manifest.json"), "utf8")
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { version: 1, sources: [] }
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(contents)
  } catch (error) {
    throw new Error(
      `Invalid managed skills manifest: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.sources)) {
    throw new Error("Invalid managed skills manifest: expected version 1 with a sources array.")
  }
  const sourceIds = new Set<string>()
  const skillNames = new Set<string>()
  const sources = value.sources.map((rawSource, sourceIndex): ManagedSkillSource => {
    if (!isRecord(rawSource))
      throw new Error(`Invalid managed skills manifest: sources[${sourceIndex}] is invalid.`)
    const id = validSourceId(rawSource.id, `sources[${sourceIndex}].id`)
    if (sourceIds.has(id))
      throw new Error(`Invalid managed skills manifest: duplicate source ${id}.`)
    sourceIds.add(id)
    const url = requiredString(rawSource.url, `sources[${sourceIndex}].url`)
    if (!Array.isArray(rawSource.skills)) {
      throw new Error(
        `Invalid managed skills manifest: sources[${sourceIndex}].skills must be an array.`,
      )
    }
    const skills = rawSource.skills.map((rawSkill, skillIndex): ManagedSkill => {
      if (!isRecord(rawSkill))
        throw new Error(`Invalid managed skills manifest: skill ${skillIndex} is invalid.`)
      const name = requiredString(
        rawSkill.name,
        `sources[${sourceIndex}].skills[${skillIndex}].name`,
      )
      if (!SKILL_NAME.test(name))
        throw new Error(`Invalid managed skills manifest: invalid skill name ${name}.`)
      if (skillNames.has(name))
        throw new Error(`Invalid managed skills manifest: duplicate skill ${name}.`)
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
  return { version: 1, sources: sortedSources(sources) }
}

async function writeManifest(root: string, manifest: SkillManagerManifest) {
  await ensurePrivateDirectory(root)
  const path = join(root, "manifest.json")
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    })
    if (process.platform !== "win32") await chmod(temporary, 0o600)
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

function sortedSources(sources: ManagedSkillSource[]) {
  return [...sources].sort((left, right) => left.id.localeCompare(right.id))
}

async function discoverManagedSkills(sourceDirectory: string): Promise<ManagedSkill[]> {
  const canonicalSource = await realpath(sourceDirectory)
  const candidates = [sourceDirectory]
  for (const collection of [
    join(sourceDirectory, "skills"),
    join(sourceDirectory, ".agents", "skills"),
  ]) {
    const entries = await readdir(collection, { withFileTypes: true }).catch((error) => {
      if (isNodeError(error) && error.code === "ENOENT") return []
      throw error
    })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isDirectory() || entry.isSymbolicLink())
        candidates.push(join(collection, entry.name))
    }
  }

  const skills = new Map<string, ManagedSkill>()
  for (const candidate of candidates) {
    const skill = await loadSkillPackage(candidate)
    if (!skill) continue
    assertInside(
      canonicalSource,
      skill.root,
      `Skill resolves outside its managed source: ${skill.name}`,
    )
    if (skills.has(skill.name))
      throw new Error(`Managed source contains duplicate skill name: ${skill.name}`)
    skills.set(skill.name, {
      name: skill.name,
      relativePath: relative(canonicalSource, skill.root) || ".",
    })
  }
  return [...skills.values()].sort((left, right) => left.name.localeCompare(right.name))
}

function validSourceId(value: unknown, label = "Skill source name") {
  const id = requiredString(value, label)
  if (id.length > 64 || !SOURCE_ID.test(id)) {
    throw new Error(
      `${label} must be 1-64 lowercase letters, numbers, dots, underscores, or hyphens.`,
    )
  }
  return id
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} must be a non-empty string.`)
  return value.trim()
}

async function ensurePrivateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  if (process.platform !== "win32") await chmod(path, 0o700)
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
    if (!pathStat.isSymbolicLink())
      throw new Error(`Skill activation is not a symbolic link: ${path}`)
    return await readlink(path)
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined
    throw error
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

async function rollback(
  originalError: unknown,
  actions: Array<() => Promise<unknown>>,
): Promise<never> {
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
    throw new AggregateError(
      [originalError, ...rollbackErrors],
      `${message} Rollback was incomplete.`,
    )
  }
  throw originalError
}
