import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { importOtherAgent, listOtherAgents } from "../../src/app/other-agents.js"
import { listMemory } from "../../src/memory/memory.js"
import { useOtisHome } from "./support/otis-home.js"

const otisHome = useOtisHome()

/** A home with all three agents set up the way their docs and source describe. */
async function agentsHome() {
  const home = await otisHome("otis-agents-")
  const cwd = join(home, "Projects.nosync", "otis")
  await mkdir(join(cwd, "src"), { recursive: true })
  // Claude Code: a global CLAUDE.md, and the repo's memory folder named after its root.
  const claude = join(home, ".claude")
  const memory = join(claude, "projects", cwd.replace(/[/.]/gu, "-"), "memory")
  await mkdir(memory, { recursive: true })
  await writeFile(join(claude, "CLAUDE.md"), "Prefer small commits.\n")
  await writeFile(join(memory, "MEMORY.md"), "- [Verify](verify.md) — run the suite\n")
  await writeFile(
    join(memory, "verify.md"),
    '---\nname: verify\ndescription: "Run the full suite before declaring work complete"\nmetadata:\n  type: feedback\n---\n\nLong body.\n',
  )
  await writeFile(
    join(memory, "token.md"),
    "---\nname: token\nmetadata:\n  type: reference\n---\n\nThe deploy key is sk-abcdefghijklmnopqrstuvwxyz0123456789 for staging.\n",
  )
  // Codex: a memory summary with the two sections that hold facts.
  await mkdir(join(home, ".codex", "memories"), { recursive: true })
  await writeFile(
    join(home, ".codex", "memories", "memory_summary.md"),
    "v1\n\n## User Profile\n\nProse.\n\n## User preferences\n\n- Treat zero matches as a valid result.\n  - desc: nested detail\n- Answer plainly when delivery is blocked.\n\n## General Tips\n\n- Read the diff file first.\n\n## What's in Memory\n\n- a route\n",
  )
  // Gemini: saved memories inside the global instruction file.
  await mkdir(join(home, ".gemini"), { recursive: true })
  await writeFile(
    join(home, ".gemini", "GEMINI.md"),
    "Be terse.\n\n## Gemini Added Memories\n- Nikita prefers bun.\n- Call me at +1 415 555 0100 after six.\n",
  )
  return { home, cwd, env: {} as NodeJS.ProcessEnv }
}

describe("other agents", () => {
  it("lists what each agent holds for the folder, redacted, with what is already remembered", async () => {
    const { home, cwd, env } = await agentsHome()
    const agents = await listOtherAgents(join(cwd, "src"), env, home)
    expect(agents.map((agent) => agent.name)).toEqual(["Claude Code", "Codex", "Gemini CLI"])
    const [claude, codex, gemini] = agents
    expect(claude.instructions).toEqual({
      path: join(home, ".claude", "CLAUDE.md"),
      text: "Prefer small commits.\n",
      imported: false,
    })
    // The repo's memory, found from a subfolder: one fact per topic file, typed by frontmatter.
    expect(claude.facts).toEqual([
      {
        scope: "workspace",
        topic: "claude-code/reference",
        text: "The deploy key is [redacted] for staging.",
        imported: false,
      },
      {
        scope: "workspace",
        topic: "claude-code/feedback",
        text: "Run the full suite before declaring work complete",
        imported: false,
      },
    ])
    expect(codex.instructions).toBeUndefined()
    expect(codex.facts.map((fact) => [fact.topic, fact.text])).toEqual([
      ["codex/preferences", "Treat zero matches as a valid result."],
      ["codex/preferences", "Answer plainly when delivery is blocked."],
      ["codex/tips", "Read the diff file first."],
    ])
    // Gemini's memories leave its instructions, which keep the rest of the file.
    expect(gemini.instructions?.text).toBe("Be terse.\n\n")
    expect(gemini.facts.map((fact) => fact.text)).toEqual([
      "Nikita prefers bun.",
      "Call me at [redacted] after six.",
    ])
  })

  it("imports the picked items once, into ~/AGENTS.md and memory, and replaces its own section", async () => {
    const { home, cwd, env } = await agentsHome()
    await writeFile(join(home, "AGENTS.md"), "# Mine\n\nKeep it short.\n")
    expect(
      await importOtherAgent(
        cwd,
        "claude-code",
        {
          instructions: true,
          facts: ["Run the full suite before declaring work complete", "not offered"],
        },
        env,
        home,
      ),
    ).toEqual({ instructions: true, facts: 1 })
    expect(await readFile(join(home, "AGENTS.md"), "utf8")).toBe(
      "# Mine\n\nKeep it short.\n\n## From Claude Code\n\nPrefer small commits.\n",
    )
    expect(await listMemory(cwd)).toEqual([
      {
        scope: "workspace",
        topic: "claude-code/feedback",
        date: new Date().toISOString().slice(0, 10),
        text: "Run the full suite before declaring work complete",
      },
    ])
    expect(
      await readFile(join(home, ".claude", "CLAUDE.md"), "utf8"),
      "the other agent's file is untouched",
    ).toBe("Prefer small commits.\n")

    // Listed again, the imported items say so; importing them again changes nothing.
    const [claude] = await listOtherAgents(cwd, env, home)
    expect(claude.instructions?.imported).toBe(true)
    expect(claude.facts.map((fact) => fact.imported)).toEqual([false, true])
    expect(
      await importOtherAgent(
        cwd,
        "claude-code",
        { instructions: true, facts: ["Run the full suite before declaring work complete"] },
        env,
        home,
      ),
    ).toEqual({ instructions: true, facts: 0 })
    expect(await listMemory(cwd)).toHaveLength(1)

    // A changed source file replaces the section it owns and leaves the rest.
    await writeFile(join(home, ".claude", "CLAUDE.md"), "Prefer tiny commits.\n")
    await writeFile(
      join(home, "AGENTS.md"),
      `${await readFile(join(home, "AGENTS.md"), "utf8")}\n## After\n\nStays.\n`,
    )
    await importOtherAgent(cwd, "claude-code", { instructions: true, facts: [] }, env, home)
    expect(await readFile(join(home, "AGENTS.md"), "utf8")).toBe(
      "# Mine\n\nKeep it short.\n\n## From Claude Code\n\nPrefer tiny commits.\n\n## After\n\nStays.\n",
    )

    // Global facts go to global memory, marked with the agent as their source.
    await importOtherAgent(
      cwd,
      "gemini",
      { instructions: false, facts: ["Nikita prefers bun."] },
      env,
      home,
    )
    const global = (await listMemory(cwd)).filter((entry) => entry.scope === "global")
    expect(global.map((entry) => [entry.topic, entry.text])).toEqual([
      ["gemini/memories", "Nikita prefers bun."],
    ])
  })

  it("lists nothing for an agent that is installed but empty", async () => {
    const home = await otisHome("otis-agents-empty-")
    const cwd = join(home, "work")
    await mkdir(join(home, ".codex", "memories"), { recursive: true })
    await mkdir(cwd, { recursive: true })
    expect(await listOtherAgents(cwd, {}, home)).toEqual([])
  })
})
