import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { SkillManager } from "../../src/skills/index.js"

const executeFile = promisify(execFile)
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("managed skills", () => {
  it("installs, lists, and removes every skill in a Git-backed collection", async () => {
    const repository = await gitRepository()
    await writeSkill(repository, "alpha", "Alpha workflow.")
    await writeSkill(repository, "beta", "Beta workflow.")
    await commit(repository, "add skills")
    const paths = await managerPaths()
    const manager = new SkillManager(paths)

    const installed = await manager.install(repository)

    expect(installed).toMatchObject({ id: repository.split("/").at(-1)?.toLowerCase(), url: repository })
    expect(installed.skills.map((skill) => skill.name)).toEqual(["alpha", "beta"])
    expect(await realpath(join(paths.activationDirectory, "alpha"))).toBe(
      await realpath(join(paths.rootDirectory, "sources", installed.id, "skills", "alpha")),
    )
    expect(await manager.list()).toEqual([installed])
    expect(JSON.parse(await readFile(join(paths.rootDirectory, "manifest.json"), "utf8"))).toEqual({
      version: 1,
      sources: [installed],
    })
    if (process.platform !== "win32") {
      expect((await stat(paths.rootDirectory)).mode & 0o777).toBe(0o700)
      expect((await stat(join(paths.rootDirectory, "manifest.json"))).mode & 0o777).toBe(0o600)
    }

    await manager.remove(installed.id)

    await expect(stat(join(paths.activationDirectory, "alpha"))).rejects.toMatchObject({ code: "ENOENT" })
    await expect(stat(join(paths.rootDirectory, "sources", installed.id))).rejects.toMatchObject({ code: "ENOENT" })
    expect(await manager.list()).toEqual([])
  })

  it("fails before activation when a skill name is already present and rolls back the clone", async () => {
    const repository = await gitRepository()
    await writeSkill(repository, "alpha", "Alpha workflow.")
    await commit(repository, "add alpha")
    const paths = await managerPaths()
    await mkdir(join(paths.activationDirectory, "alpha"), { recursive: true })
    await writeFile(join(paths.activationDirectory, "alpha", "owner.txt"), "manual")
    const manager = new SkillManager(paths)

    await expect(manager.install(repository)).rejects.toThrow("not managed by this source")

    expect(await readFile(join(paths.activationDirectory, "alpha", "owner.txt"), "utf8")).toBe("manual")
    expect(await manager.list()).toEqual([])
    const sources = await directoryEntries(join(paths.rootDirectory, "sources"))
    expect(sources).toEqual([])
  })

  it("updates with fast-forward-only Git pulls and reconciles added and removed skills", async () => {
    const repository = await gitRepository()
    await writeSkill(repository, "alpha", "Alpha workflow.")
    await commit(repository, "add alpha")
    const paths = await managerPaths()
    const manager = new SkillManager(paths)
    const installed = await manager.install(repository, "workflows")

    await rm(join(repository, "skills", "alpha"), { recursive: true })
    await writeSkill(repository, "beta", "Beta workflow.")
    await commit(repository, "replace alpha with beta")
    const [updated] = await manager.update("workflows")

    expect(updated.skills).toEqual([{ name: "beta", relativePath: join("skills", "beta") }])
    await expect(stat(join(paths.activationDirectory, "alpha"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(await realpath(join(paths.activationDirectory, "beta"))).toBe(
      await realpath(join(paths.rootDirectory, "sources", installed.id, "skills", "beta")),
    )
  })

  it("rolls back an updated checkout when a newly introduced skill collides", async () => {
    const repository = await gitRepository()
    await writeSkill(repository, "alpha", "Alpha workflow.")
    await commit(repository, "add alpha")
    const paths = await managerPaths()
    const manager = new SkillManager(paths)
    await manager.install(repository, "workflows")
    const checkout = join(paths.rootDirectory, "sources", "workflows")
    const previousCommit = await git(checkout, "rev-parse", "HEAD")

    await writeSkill(repository, "collision", "Conflicting workflow.")
    await commit(repository, "add collision")
    await mkdir(join(paths.activationDirectory, "collision"))

    await expect(manager.update("workflows")).rejects.toThrow("conflicts with an existing skill")

    expect(await git(checkout, "rev-parse", "HEAD")).toBe(previousCommit)
    expect(await realpath(join(paths.activationDirectory, "alpha"))).toBe(
      await realpath(join(checkout, "skills", "alpha")),
    )
    expect(await manager.list()).toEqual([
      expect.objectContaining({ id: "workflows", skills: [{ name: "alpha", relativePath: join("skills", "alpha") }] }),
    ])
  })

  it("refuses to remove an activation that was replaced outside Otis", async () => {
    const repository = await gitRepository()
    await writeSkill(repository, "alpha", "Alpha workflow.")
    await commit(repository, "add alpha")
    const paths = await managerPaths()
    const manager = new SkillManager(paths)
    await manager.install(repository, "workflows")
    await rm(join(paths.activationDirectory, "alpha"))
    await mkdir(join(paths.activationDirectory, "alpha"))

    await expect(manager.remove("workflows")).rejects.toThrow("not a symbolic link")

    expect(await manager.list()).toHaveLength(1)
    await expect(stat(join(paths.rootDirectory, "sources", "workflows"))).resolves.toBeDefined()
  })

  it("installs a repository whose root is a single skill", async () => {
    const repository = await gitRepository()
    await writeFile(
      join(repository, "SKILL.md"),
      "---\nname: root-workflow\ndescription: Root workflow.\n---\n\nUse the root workflow.\n",
    )
    await commit(repository, "add root skill")
    const paths = await managerPaths()
    const manager = new SkillManager(paths)

    const installed = await manager.install(repository, "root-workflow")

    expect(installed.skills).toEqual([{ name: installed.id, relativePath: "." }])
  })
})

async function gitRepository() {
  const repository = await temporaryDirectory("otis-skill-repository-")
  await executeFile("git", ["init", "--initial-branch=main", repository])
  await git(repository, "config", "user.name", "Otis Tests")
  await git(repository, "config", "user.email", "otis@example.invalid")
  return repository
}

async function writeSkill(repository: string, name: string, description: string) {
  const directory = join(repository, "skills", name)
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nFollow ${name}.\n`,
  )
}

async function commit(repository: string, message: string) {
  await git(repository, "add", ".")
  await git(repository, "commit", "-m", message)
}

async function git(repository: string, ...args: string[]) {
  return (await executeFile("git", ["-C", repository, ...args])).stdout.trim()
}

async function managerPaths() {
  const base = await temporaryDirectory("otis-skill-manager-")
  return {
    rootDirectory: join(base, "managed"),
    activationDirectory: join(base, "active"),
  }
}

async function directoryEntries(path: string) {
  try {
    return await readdir(path)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
    throw error
  }
}

async function temporaryDirectory(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}
