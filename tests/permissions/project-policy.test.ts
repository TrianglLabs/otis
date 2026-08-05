import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { loadProjectPermissionRules } from "../../src/permissions/project-policy.js"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("project permission policy", () => {
  it("loads restrictive project rules", async () => {
    const cwd = await tempDirectory()
    await mkdir(join(cwd, ".otis"))
    await writeFile(
      join(cwd, ".otis", "permissions.json"),
      JSON.stringify({ version: 1, rules: [{ tool: "read", resource: "*.env", effect: "deny" }] }),
    )
    await expect(loadProjectPermissionRules(cwd)).resolves.toEqual([
      { tool: "read", resource: "*.env", effect: "deny" },
    ])
  })

  it("rejects project rules that grant access", async () => {
    const cwd = await tempDirectory()
    await mkdir(join(cwd, ".otis"))
    await writeFile(
      join(cwd, ".otis", "permissions.json"),
      JSON.stringify({ version: 1, rules: [{ tool: "bash", resource: "git *", effect: "allow" }] }),
    )
    await expect(loadProjectPermissionRules(cwd)).rejects.toThrow("may not grant access")
  })

  it("rejects a project default mode", async () => {
    const cwd = await tempDirectory()
    await mkdir(join(cwd, ".otis"))
    await writeFile(join(cwd, ".otis", "permissions.json"), JSON.stringify({ version: 1, defaultMode: "auto" }))
    await expect(loadProjectPermissionRules(cwd)).rejects.toThrow("may not set defaultMode")
  })
})

async function tempDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "otis-permissions-"))
  directories.push(directory)
  return directory
}
