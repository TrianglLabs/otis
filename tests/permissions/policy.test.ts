import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  createPermissionPolicy,
  loadProjectPermissionRules,
  parsePermissionConfig,
  parsePermissionRuleString,
} from "../../src/permissions/policy.js"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("permission policy", () => {
  it("requires external publication approval even in auto mode, with canonical path rules", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "otis-publication-policy-")))
    try {
      const cwd = join(root, "workspace")
      await mkdir(cwd)
      await writeFile(join(cwd, "inside.md"), "Inside")
      await writeFile(join(root, "outside.md"), "Outside")
      await symlink(join(root, "outside.md"), join(cwd, "alias.md"))
      const call = (path: string) => ({ name: "publish_artifact" as const, input: { path } })
      const auto = createPermissionPolicy({ cwd, mode: "auto" })
      expect((await auto.evaluate(call("inside.md"))).effect).toBe("allow")
      const external = await auto.evaluate(call("../outside.md"))
      expect(external.effect).toBe("ask")
      expect(external.resources).toEqual([external.artifactPath])
      expect((await auto.evaluate(call("alias.md"))).effect).toBe("ask")
      expect(
        (await createPermissionPolicy({ cwd, mode: "dontAsk" }).evaluate(call("../outside.md")))
          .effect,
      ).toBe("deny")
      const allowed = createPermissionPolicy({
        cwd,
        mode: "dontAsk",
        rules: [{ tool: "publish_artifact", resource: external.artifactPath, effect: "allow" }],
      })
      expect((await allowed.evaluate(call("../outside.md"))).effect).toBe("allow")
      const denied = createPermissionPolicy({
        cwd,
        mode: "auto",
        rules: [
          { tool: "publish_artifact", resource: "*", effect: "allow" },
          { tool: "publish_artifact", resource: external.artifactPath, effect: "deny" },
        ],
      })
      expect((await denied.evaluate(call("alias.md"))).effect).toBe("deny")
      expect((await denied.evaluate(call("inside.md"))).effect).toBe("allow")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("uses safe defaults for reads and mode defaults for restricted tools", async () => {
    const cwd = process.cwd()
    const ask = createPermissionPolicy({ cwd, mode: "ask" })
    const auto = createPermissionPolicy({ cwd, mode: "auto" })
    const dontAsk = createPermissionPolicy({ cwd, mode: "dontAsk" })

    expect((await ask.evaluate({ name: "read", input: { path: "src/index.ts" } })).effect).toBe(
      "allow",
    )
    expect((await ask.evaluate({ name: "skill", input: { skill: "review" } })).effect).toBe("allow")
    expect((await ask.evaluate({ name: "bash", input: { command: "bun test" } })).effect).toBe(
      "ask",
    )
    expect(
      (await auto.evaluate({ name: "write", input: { path: "out.txt", content: "ok" } })).effect,
    ).toBe("allow")
    expect(
      (await dontAsk.evaluate({ name: "edit", input: { path: "out.txt", old: "a", new: "b" } }))
        .effect,
    ).toBe("deny")
    expect(
      (
        await dontAsk.evaluate({
          name: "edit_document",
          input: {
            path: "package.json",
            replaceOriginal: false,
            operation: { kind: "replace_text", replacements: [{ old: "a", new: "b" }] },
          },
        })
      ).effect,
    ).toBe("deny")
    expect(
      (await dontAsk.evaluate({ name: "agent", input: { description: "Map", prompt: "List." } }))
        .effect,
    ).toBe("allow")
  })

  it("checks both source and destination for document copy edits", async () => {
    const policy = createPermissionPolicy({ cwd: process.cwd(), mode: "ask" })

    expect(
      await policy.evaluate({
        name: "edit_document",
        input: {
          path: "package.json",
          outputPath: "reviewed.json",
          replaceOriginal: false,
          operation: { kind: "replace_text", replacements: [{ old: "a", new: "b" }] },
        },
      }),
    ).toMatchObject({ effect: "ask", resources: ["package.json", "reviewed.json"] })
  })

  it("lets rules deny delegation by description", async () => {
    const policy = createPermissionPolicy({
      cwd: "/workspace",
      mode: "auto",
      rules: [{ tool: "agent", resource: "Deploy *", effect: "deny" }],
    })
    const call = (description: string) => ({
      name: "agent" as const,
      input: { description, prompt: "Do it." },
    })

    expect((await policy.evaluate(call("Deploy to production"))).effect).toBe("deny")
    expect((await policy.evaluate(call("Map the notes"))).effect).toBe("allow")
    expect(parsePermissionRuleString("agent", "deny")).toEqual({ tool: "agent", effect: "deny" })
  })

  it("evaluates matching rules with deny then ask then allow precedence", async () => {
    const policy = createPermissionPolicy({
      cwd: "/workspace",
      mode: "dontAsk",
      rules: [
        { tool: "bash", resource: "git *", effect: "allow" },
        { tool: "bash", resource: "git push *", effect: "ask" },
        { tool: "bash", resource: "git push --force *", effect: "deny" },
      ],
    })

    expect((await policy.evaluate({ name: "bash", input: { command: "git status" } })).effect).toBe(
      "allow",
    )
    expect(
      (await policy.evaluate({ name: "bash", input: { command: "git push origin main" } })).effect,
    ).toBe("ask")
    expect(
      (await policy.evaluate({ name: "bash", input: { command: "git push --force origin main" } }))
        .effect,
    ).toBe("deny")
  })

  it("does not let a shell wildcard authorize control operators or command substitution", async () => {
    const policy = createPermissionPolicy({
      cwd: "/workspace",
      mode: "dontAsk",
      rules: [{ tool: "bash", resource: "git *", effect: "allow" }],
    })

    expect(
      (await policy.evaluate({ name: "bash", input: { command: "git status && rm -rf ." } }))
        .effect,
    ).toBe("deny")
    expect(
      (await policy.evaluate({ name: "bash", input: { command: "git status $(touch owned)" } }))
        .effect,
    ).toBe("deny")
    expect((await policy.evaluate({ name: "bash", input: { command: "git status" } })).effect).toBe(
      "allow",
    )
  })

  it("lets restrictive shell wildcards match control operators", async () => {
    const policy = createPermissionPolicy({
      cwd: "/workspace",
      mode: "auto",
      rules: [{ tool: "bash", resource: "*", effect: "deny" }],
    })

    expect(
      (await policy.evaluate({ name: "bash", input: { command: "git status && rm -rf ." } }))
        .effect,
    ).toBe("deny")
    expect(
      (await policy.evaluate({ name: "bash", input: { command: "echo $(cat .env)" } })).effect,
    ).toBe("deny")
  })

  it("normalizes workspace paths before matching rules", async () => {
    const cwd = process.cwd()
    const policy = createPermissionPolicy({
      cwd,
      mode: "ask",
      rules: [{ tool: "read", resource: "src/*", effect: "deny" }],
    })

    expect(
      await policy.evaluate({ name: "read", input: { path: join(cwd, "src/token") } }),
    ).toMatchObject({
      effect: "deny",
      resources: ["src/token"],
    })
  })

  it("checks every web search query against a rule", async () => {
    const policy = createPermissionPolicy({
      cwd: "/workspace",
      mode: "auto",
      rules: [{ tool: "web_search", resource: "*private.example*", effect: "deny" }],
    })
    expect(
      (
        await policy.evaluate({
          name: "web_search",
          input: { objective: "research", searchQueries: ["public docs", "private.example token"] },
        })
      ).effect,
    ).toBe("deny")
  })

  it("checks both a requested symlink and its canonical target", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "otis-policy-"))
    try {
      await mkdir(join(cwd, "secrets"))
      await writeFile(join(cwd, "secrets", "token"), "secret")
      await symlink(join(cwd, "secrets", "token"), join(cwd, "alias"))
      const policy = createPermissionPolicy({
        cwd,
        mode: "auto",
        rules: [{ tool: "read", resource: "secrets/*", effect: "deny" }],
      })

      expect(await policy.evaluate({ name: "read", input: { path: "alias" } })).toMatchObject({
        effect: "deny",
        resources: ["alias", "secrets/token"],
      })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it("parses config objects and command-line Tool(resource) rules", () => {
    expect(
      parsePermissionConfig({
        defaultMode: "ask",
        rules: [{ tool: "bash", resource: "bun test*", effect: "allow" }],
      }),
    ).toEqual({
      defaultMode: "ask",
      rules: [{ tool: "bash", resource: "bun test*", effect: "allow" }],
    })
    expect(parsePermissionRuleString("bash(git status)", "allow")).toEqual({
      tool: "bash",
      resource: "git status",
      effect: "allow",
    })
    expect(parsePermissionRuleString("Bash(git *)", "allow")).toEqual({
      tool: "bash",
      resource: "git *",
      effect: "allow",
    })
    expect(
      parsePermissionConfig({ rules: [{ tool: "READ", resource: "*.env", effect: "deny" }] }),
    ).toEqual({
      rules: [{ tool: "read", resource: "*.env", effect: "deny" }],
    })
  })

  it("rejects unknown tools and malformed effects", () => {
    expect(() => parsePermissionConfig({ rules: [{ tool: "bas", effect: "allow" }] })).toThrow(
      "known tool",
    )
    expect(() => parsePermissionConfig({ rules: [{ tool: "bash", effect: "sometimes" }] })).toThrow(
      "allow, ask, or deny",
    )
  })
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
    await writeFile(
      join(cwd, ".otis", "permissions.json"),
      JSON.stringify({ version: 1, defaultMode: "auto" }),
    )
    await expect(loadProjectPermissionRules(cwd)).rejects.toThrow("may not set defaultMode")
  })
})

async function tempDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "otis-permissions-"))
  directories.push(directory)
  return directory
}
