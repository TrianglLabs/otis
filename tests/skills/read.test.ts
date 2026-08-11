import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { loadSkillCatalog, readSkillResource } from "../../src/skills/index.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("skill resources", () => {
  it("loads instructions and referenced text progressively", async () => {
    const home = await temporaryDirectory()
    const project = await temporaryDirectory()
    const root = join(project, ".agents", "skills", "review")
    await mkdir(join(root, "references"), { recursive: true })
    await writeFile(
      join(root, "SKILL.md"),
      "---\nname: review\ndescription: Review changes.\n---\nRead references/RULES.md\n",
    )
    await writeFile(join(root, "references", "RULES.md"), "Check behavior, not implementation details.\n")
    const catalog = await loadSkillCatalog(project, { home })

    const instructions = await readSkillResource(catalog, "review")
    const reference = await readSkillResource(catalog, "review", "references/RULES.md")

    expect(instructions.output).toContain(`Skill root: ${catalog.byName.get("review")?.root}`)
    expect(instructions.output).toContain("Read references/RULES.md")
    expect(reference.output).toBe("Check behavior, not implementation details.\n")
  })

  it("rejects traversal and symlinks outside the selected skill", async () => {
    const home = await temporaryDirectory()
    const project = await temporaryDirectory()
    const outside = await temporaryDirectory()
    const root = join(project, ".agents", "skills", "safe-skill")
    await mkdir(root, { recursive: true })
    await writeFile(join(root, "SKILL.md"), "---\nname: safe-skill\ndescription: Safe.\n---\n")
    await writeFile(join(outside, "secret.txt"), "secret")
    await symlink(join(outside, "secret.txt"), join(root, "secret.txt"))
    const catalog = await loadSkillCatalog(project, { home })

    await expect(readSkillResource(catalog, "safe-skill", "../secret.txt")).rejects.toThrow("outside the skill root")
    await expect(readSkillResource(catalog, "safe-skill", "secret.txt")).rejects.toThrow("outside the skill root")
  })
})

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "otis-skill-read-"))
  temporaryDirectories.push(directory)
  return directory
}
