import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { loadSkillCatalog } from "../../src/skills/index.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("skill catalog", () => {
  it("discovers global and project skills with nearest project definitions taking precedence", async () => {
    const home = await temporaryDirectory()
    const project = await temporaryDirectory()
    const nested = join(project, "packages", "app")
    await mkdir(nested, { recursive: true })
    await writeSkill(home, "shared", "Global description", "Global instructions")
    await writeSkill(project, "shared", "Project description", "Project instructions")
    await writeSkill(project, "project-only", "Project workflow", "Do project work")

    const catalog = await loadSkillCatalog(nested, { home })

    expect(catalog.skills.map((skill) => skill.name)).toEqual(["project-only", "shared"])
    expect(catalog.byName.get("shared")).toMatchObject({ description: "Project description" })
    expect(catalog.byName.get("shared")?.root).toBe(await realpath(join(project, ".agents", "skills", "shared")))
  })

  it("accepts full YAML frontmatter and validates portable skill metadata", async () => {
    const home = await temporaryDirectory()
    const project = await temporaryDirectory()
    const directory = join(project, ".agents", "skills", "release-notes")
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, "SKILL.md"),
      `---\nname: release-notes\ndescription: >-\n  Prepare consistent release notes for shipped changes.\nlicense: MIT\nmetadata:\n  version: "1"\n---\n\n# Workflow\n`,
    )

    const catalog = await loadSkillCatalog(project, { home })

    expect(catalog.skills).toHaveLength(1)
    expect(catalog.skills[0]).toMatchObject({
      name: "release-notes",
      description: "Prepare consistent release notes for shipped changes.",
    })
  })

  it("rejects malformed manifests instead of silently advertising incorrect skills", async () => {
    const home = await temporaryDirectory()
    const project = await temporaryDirectory()
    const directory = join(project, ".agents", "skills", "wrong-directory")
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, "SKILL.md"), "---\nname: another-name\ndescription: Test\n---\nBody\n")

    await expect(loadSkillCatalog(project, { home })).rejects.toThrow("name must match its parent directory")
  })
})

async function writeSkill(base: string, name: string, description: string, body: string) {
  const directory = join(base, ".agents", "skills", name)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`)
}

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "otis-skills-"))
  temporaryDirectories.push(directory)
  return directory
}
