import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { loadSkillCatalog, readSkillResource } from "../../src/skills/index.js"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "otis-bundled-"))
  directories.push(root)
  const catalog = await loadSkillCatalog(root, { home: root, dataDirectory: join(root, "private") })
  const skill = catalog.byName.get("documents")
  if (!skill) throw new Error("Bundled documents skill is missing")
  return { root, catalog, skill }
}

describe("bundled document skill", () => {
  it("is discoverable without writes and materializes exact helpers on demand", async () => {
    const { root, catalog, skill } = await setup()
    expect(await readdir(root)).toEqual([])
    const [first, second] = await Promise.all([
      readSkillResource(catalog, "documents"),
      readSkillResource(catalog, "documents"),
    ])
    expect(first.output).toBe(second.output)
    expect(first.output).toContain("Skill root:")
    expect((await readdir(skill.root)).sort()).toEqual([
      "SKILL.md",
      "document.py",
      "pdf_edit.py",
      "requirements.txt",
      "spec.md",
    ])
    const script = await readSkillResource(catalog, "documents", "document.py")
    expect(script.output).toBe(await readFile(join(skill.root, "document.py"), "utf8"))
    if (process.platform !== "win32")
      expect((await stat(join(skill.root, "document.py"))).mode & 0o777).toBe(0o600)
    await expect(readSkillResource(catalog, "documents", "../secret.txt")).rejects.toThrow(
      "outside",
    )
  })

  it("refuses modified cached scripts and symlinked cache directories", async () => {
    const { catalog, skill } = await setup()
    await readSkillResource(catalog, "documents")
    await writeFile(join(skill.root, "document.py"), "changed")
    await expect(readSkillResource(catalog, "documents")).rejects.toThrow("was modified")
    await rm(skill.root, { recursive: true })
    const outside = await mkdtemp(join(tmpdir(), "otis-bundle-outside-"))
    directories.push(outside)
    await symlink(outside, skill.root)
    await expect(readSkillResource(catalog, "documents")).rejects.toThrow("symlink")
    expect(await readdir(outside)).toEqual([])
  })

  it("lets an explicitly installed project skill override the bundled workflow", async () => {
    const { root } = await setup()
    const path = join(root, ".agents", "skills", "documents", "SKILL.md")
    await mkdir(dirname(path), { recursive: true })
    await writeFile(
      path,
      "---\nname: documents\ndescription: Our workflow.\n---\nProject instructions.",
    )
    const catalog = await loadSkillCatalog(root, { home: root })
    expect(catalog.byName.get("documents")?.bundled).toBeUndefined()
    expect((await readSkillResource(catalog, "documents")).output).toContain(
      "Project instructions.",
    )
  })
})
