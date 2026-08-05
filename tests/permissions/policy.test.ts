import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  createPermissionPolicy,
  parsePermissionConfig,
  parsePermissionRuleString,
} from "../../src/permissions/policy.js"

describe("permission policy", () => {
  it("uses safe defaults for reads and mode defaults for restricted tools", async () => {
    const cwd = process.cwd()
    const ask = createPermissionPolicy({ cwd, mode: "ask" })
    const auto = createPermissionPolicy({ cwd, mode: "auto" })
    const dontAsk = createPermissionPolicy({ cwd, mode: "dontAsk" })

    expect((await ask.evaluate({ name: "read", input: { path: "src/index.ts" } })).effect).toBe("allow")
    expect((await ask.evaluate({ name: "bash", input: { command: "bun test" } })).effect).toBe("ask")
    expect((await auto.evaluate({ name: "write", input: { path: "out.txt", content: "ok" } })).effect).toBe("allow")
    expect((await dontAsk.evaluate({ name: "edit", input: { path: "out.txt", old: "a", new: "b" } })).effect).toBe(
      "deny",
    )
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

    expect((await policy.evaluate({ name: "bash", input: { command: "git status" } })).effect).toBe("allow")
    expect((await policy.evaluate({ name: "bash", input: { command: "git push origin main" } })).effect).toBe("ask")
    expect((await policy.evaluate({ name: "bash", input: { command: "git push --force origin main" } })).effect).toBe(
      "deny",
    )
  })

  it("does not let a shell wildcard authorize control operators or command substitution", async () => {
    const policy = createPermissionPolicy({
      cwd: "/workspace",
      mode: "dontAsk",
      rules: [{ tool: "bash", resource: "git *", effect: "allow" }],
    })

    expect((await policy.evaluate({ name: "bash", input: { command: "git status && rm -rf ." } })).effect).toBe("deny")
    expect((await policy.evaluate({ name: "bash", input: { command: "git status $(touch owned)" } })).effect).toBe(
      "deny",
    )
    expect((await policy.evaluate({ name: "bash", input: { command: "git status" } })).effect).toBe("allow")
  })

  it("lets restrictive shell wildcards match control operators", async () => {
    const policy = createPermissionPolicy({
      cwd: "/workspace",
      mode: "auto",
      rules: [{ tool: "bash", resource: "*", effect: "deny" }],
    })

    expect((await policy.evaluate({ name: "bash", input: { command: "git status && rm -rf ." } })).effect).toBe("deny")
    expect((await policy.evaluate({ name: "bash", input: { command: "echo $(cat .env)" } })).effect).toBe("deny")
  })

  it("normalizes workspace paths before matching rules", async () => {
    const cwd = process.cwd()
    const policy = createPermissionPolicy({
      cwd,
      mode: "ask",
      rules: [{ tool: "read", resource: "src/*", effect: "deny" }],
    })

    expect(await policy.evaluate({ name: "read", input: { path: join(cwd, "src/token") } })).toMatchObject({
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
    expect(parsePermissionConfig({ rules: [{ tool: "READ", resource: "*.env", effect: "deny" }] })).toEqual({
      rules: [{ tool: "read", resource: "*.env", effect: "deny" }],
    })
  })

  it("rejects unknown tools and malformed effects", () => {
    expect(() => parsePermissionConfig({ rules: [{ tool: "bas", effect: "allow" }] })).toThrow("known tool")
    expect(() => parsePermissionConfig({ rules: [{ tool: "bash", effect: "sometimes" }] })).toThrow(
      "allow, ask, or deny",
    )
  })
})
