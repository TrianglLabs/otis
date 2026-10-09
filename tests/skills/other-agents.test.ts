import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { loadSkillCatalog } from "../../src/skills/catalog.js"

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function skill(root: string, name: string, description: string) {
  await mkdir(join(root, name), { recursive: true })
  await writeFile(
    join(root, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  )
}

describe("skills from other agents' folders", () => {
  it("loads them beside .agents/skills, which wins on a shared name, unless told not to", async () => {
    const home = await mkdtemp(join(tmpdir(), "otis-skills-home-"))
    const cwd = await mkdtemp(join(tmpdir(), "otis-skills-cwd-"))
    dirs.push(home, cwd)
    await skill(join(home, ".claude", "skills"), "release", "Claude's release skill")
    await skill(join(home, ".copilot", "skills"), "triage", "Copilot's triage skill")
    await skill(join(cwd, ".cursor", "skills"), "review", "Cursor's review skill")
    await skill(join(cwd, ".github", "skills"), "deploy", "Copilot's deploy skill")
    await skill(join(cwd, ".gemini", "skills"), "deploy", "Gemini's deploy skill")
    await skill(join(cwd, ".agents", "skills"), "deploy", "The project's deploy skill")

    const catalog = await loadSkillCatalog(cwd, { home })
    expect(
      catalog.skills
        .filter((entry) => !entry.bundled)
        .map((entry) => [entry.name, entry.description]),
    ).toEqual([
      ["deploy", "The project's deploy skill"],
      ["release", "Claude's release skill"],
      ["review", "Cursor's review skill"],
      ["triage", "Copilot's triage skill"],
    ])

    const own = await loadSkillCatalog(cwd, { home, otherAgents: false })
    expect(own.skills.filter((entry) => !entry.bundled).map((entry) => entry.name)).toEqual([
      "deploy",
    ])
  })
})
