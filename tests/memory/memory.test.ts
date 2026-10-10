import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  forget,
  listMemory,
  memoryIndex,
  memoryTopic,
  recall,
  redactPrivate,
  remember,
} from "../../src/memory/memory.js"
import { runGit } from "../../src/skills/manager.js"
import { defaultSessionDirectory } from "../../src/storage/session-files.js"
import { executeToolCall } from "../../src/tools/index.js"
import { useOtisHome } from "../app/support/otis-home.js"

const otisHome = useOtisHome()
const today = new Date().toISOString().slice(0, 10)

describe("memory", () => {
  it("files facts under indexed topics per scope and forgets by text", async () => {
    const { home, cwd } = await scratch()
    const workspace = join(defaultSessionDirectory(cwd), "memory")
    await remember("workspace", "  The limiter lives   in src/net/limiter.ts.  ", cwd, "session-1")
    await remember("global", "Prefer bun over npm.", cwd, undefined, "tooling")
    expect(await readFile(join(workspace, "general.md"), "utf8")).toBe(
      `# General\n\n- The limiter lives in src/net/limiter.ts. [source: session-1; added: ${today}]\n`,
    )
    expect(await readFile(join(workspace, "MEMORY.md"), "utf8")).toBe(
      "# Memory: workspace\n\n- [[general]]\n",
    )
    expect(await readFile(join(home, "memory", "MEMORY.md"), "utf8")).toBe(
      "# Memory: Otis\n\n- [[tooling]]\n",
    )
    expect(await listMemory(cwd)).toEqual([
      {
        scope: "workspace",
        topic: "general",
        date: today,
        text: "The limiter lives in src/net/limiter.ts.",
      },
      { scope: "global", topic: "tooling", date: today, text: "Prefer bun over npm." },
    ])

    // A hand-written topic counts, without dates, with a missing final newline, and joins the
    // index once a fact is filed under it.
    await writeFile(
      join(home, "memory", "notes.md"),
      "# Notes\nFree text.\n- Deploys go through CI.",
    )
    await remember("global", "Releases are tagged from main.", cwd, undefined, "notes")
    expect((await listMemory(cwd)).map((entry) => `${entry.topic}: ${entry.text}`)).toEqual([
      "general: The limiter lives in src/net/limiter.ts.",
      "notes: Deploys go through CI.",
      "notes: Releases are tagged from main.",
      "tooling: Prefer bun over npm.",
    ])
    expect(await readFile(join(home, "memory", "MEMORY.md"), "utf8")).toBe(
      "# Memory: Otis\n\n- [[tooling]]\n- [[notes]]\n",
    )
    await expect(forget("global", "go through", cwd)).resolves.toEqual({
      scope: "global",
      topic: "notes",
      text: "Deploys go through CI.",
    })
    await expect(forget("global", "nothing like this", cwd)).rejects.toThrow("Nothing in global")
    await remember("global", "Prefer bun for tests.", cwd)
    await expect(forget("global", "prefer bun", cwd)).rejects.toThrow("matches 2")
    await expect(remember("workspace", "   ", cwd)).rejects.toThrow("nothing to remember")

    // Forgetting a topic's last fact removes the file and its link; the heading alone is no fact.
    await forget("workspace", "limiter", cwd)
    await expect(readdir(workspace)).resolves.toEqual(["MEMORY.md"])
    expect(await readFile(join(workspace, "MEMORY.md"), "utf8")).toBe("# Memory: workspace\n\n")
    await remember("workspace", "Payments ship on October 15.", cwd, undefined, "projects/payments")
    expect(await readFile(join(workspace, "projects", "payments.md"), "utf8")).toBe(
      `# Payments\n\n- Payments ship on October 15. [added: ${today}]\n`,
    )
    expect(await readFile(join(workspace, "MEMORY.md"), "utf8")).toBe(
      "# Memory: workspace\n\n- [[projects/payments]]\n",
    )
    expect((await listMemory(cwd)).map((entry) => entry.topic)).toContain("projects/payments")
  })

  it("normalizes topic names to link paths", () => {
    expect(memoryTopic(undefined)).toBe("general")
    expect(memoryTopic("  Deploy Steps ")).toBe("deploy-steps")
    expect(memoryTopic("projects/Payments.md")).toBe("projects/payments")
    expect(memoryTopic("snake_case")).toBe("snake-case")
    expect(memoryTopic("a//b")).toBe("a/b")
    expect(() => memoryTopic("???")).toThrow("not a usable topic")
  })

  it("keeps a hand-kept index and ignores files that are not topics", async () => {
    const { home, cwd } = await scratch()
    const root = join(home, "memory")
    // A dot folder, as a real repository's `.git` would be, holds no topics.
    await mkdir(join(root, ".cache", "info"), { recursive: true })
    await mkdir(join(root, "projects"), { recursive: true })
    await writeFile(
      join(root, "MEMORY.md"),
      "# Memory: shared\n\nIntro.\n\n- [[general]] — basics\n",
    )
    await writeFile(join(root, "README.md"), "- A readme line.\n")
    await writeFile(join(root, ".cache", "info", "notes.md"), "- Not a fact.\n")
    await writeFile(join(root, "projects", "MEMORY.md"), "- Nor this.\n")
    await writeFile(join(root, "general.md"), "- See the [docs] [added: 2026-01-02]\n")
    await remember("global", "Prefer bun over npm.", cwd)
    // The annotated link already names the topic, so the index is left as the user wrote it.
    expect(await readFile(join(root, "MEMORY.md"), "utf8")).toBe(
      "# Memory: shared\n\nIntro.\n\n- [[general]] — basics\n",
    )
    expect((await listMemory(cwd)).map((entry) => `${entry.topic}: ${entry.text}`)).toEqual([
      "README: A readme line.",
      "general: See the [docs]",
      "general: Prefer bun over npm.",
    ])
    await forget("global", "readme line", cwd)
    await forget("global", "see the", cwd)
    await forget("global", "prefer bun", cwd)
    expect(await readFile(join(root, "MEMORY.md"), "utf8")).toBe("# Memory: shared\n\nIntro.\n\n")
  })

  it("moves facts from the single-file layouts of earlier releases on first use", async () => {
    const { home, cwd } = await scratch()
    await writeFile(
      join(home, "memory.md"),
      "- 2026-09-27 [s1]: Old global fact.\n- 2026-09-28: Dated.\n- Plain.\n",
    )
    await mkdir(join(cwd, ".otis"))
    await writeFile(join(cwd, ".otis", "memory.md"), "- Old fact.\n")
    expect((await listMemory(cwd)).map((entry) => entry.text)).toEqual([
      "Old fact.",
      "Old global fact.",
      "Dated.",
      "Plain.",
    ])
    expect(await readFile(join(home, "memory", "general.md"), "utf8")).toBe(
      "# General\n\n- Old global fact. [source: s1; added: 2026-09-27]\n- Dated. [added: 2026-09-28]\n- Plain.\n",
    )
    await expect(readFile(join(home, "memory.md"))).rejects.toThrow()
    await expect(readFile(join(cwd, ".otis", "memory.md"))).rejects.toThrow()
    await expect(readdir(cwd)).resolves.not.toContain(".otis")
  })

  it("commits every change when the memory folder is a git repository, and never elsewhere", async () => {
    const { home, cwd } = await scratch()
    const root = join(home, "memory")
    await mkdir(root, { recursive: true })
    await runGit(["init", "--quiet"], { cwd: root })
    await runGit(["config", "user.email", "otis@example.test"], { cwd: root })
    await runGit(["config", "user.name", "Otis"], { cwd: root })
    // The data folder itself under version control is the user's business, not a memory repo.
    await runGit(["init", "--quiet"], { cwd: home })

    const remembered = await remember("global", "Prefer bun over npm.", cwd, "s-1", "tooling")
    expect(remembered.commit).toMatch(/^[0-9a-f]{7,}$/u)
    const forgotten = await forget("global", "prefer bun", cwd)
    expect(forgotten.commit).toMatch(/^[0-9a-f]{7,}$/u)
    expect(forgotten.commit).not.toBe(remembered.commit)
    expect(await runGit(["log", "--format=%s"], { cwd: root })).toBe(
      "memory: forget tooling\nmemory: remember tooling\n",
    )
    expect(await runGit(["status", "--porcelain"], { cwd: root })).toBe("")
    expect(await runGit(["show", "--stat", "--format=", "HEAD~1"], { cwd: root })).toMatch(
      /MEMORY\.md[\s\S]*tooling\.md/u,
    )

    // The workspace folder is plain, so its facts are written without a commit, and the
    // repository around the data folder sees nothing from Otis.
    const plain = await remember("workspace", "Tests run with bun test.", cwd)
    expect(plain).not.toHaveProperty("commit")
    expect(await runGit(["status", "--porcelain"], { cwd: home })).toContain("?? sessions/")
    await expect(runGit(["log", "--oneline"], { cwd: home })).rejects.toThrow()
  })

  it("keeps the fact and says so when the repository refuses the commit", async () => {
    const { home, cwd } = await scratch()
    const root = join(home, "memory")
    await mkdir(root, { recursive: true })
    await runGit(["init", "--quiet"], { cwd: root })
    await runGit(["config", "user.useConfigOnly", "true"], { cwd: root })
    await runGit(["config", "user.email", ""], { cwd: root })
    await runGit(["config", "user.name", ""], { cwd: root })
    await expect(remember("global", "Prefer bun over npm.", cwd)).rejects.toThrow(
      "Saved, but the memory repository commit failed",
    )
    expect(await readFile(join(root, "general.md"), "utf8")).toMatch(
      /^# General\n\n- Prefer bun over npm\. \[added: \d{4}-\d{2}-\d{2}\]\n$/u,
    )
  })

  it("redacts credentials and personal details before they are written or shown", async () => {
    expect(
      redactPrivate("token sk-abcdefghijklmnopqrstuvwxyz1234 and key=ghp_ABCDEFGHIJKLMNOPQRSTUV"),
    ).toBe("token [redacted] and key=[redacted]")
    expect(
      redactPrivate("api_key: 12345 AKIAABCDEFGHIJKLMNOP Bearer abcdefghijklmnopqrstuvwxyz"),
    ).toBe("api_key: [redacted] [redacted] [redacted]")
    expect(
      redactPrivate(
        "Ask ana.lopez+ops@example.co.uk or +44 20 7946 0958, card 4111 1111 1111 1111",
      ),
    ).toBe("Ask [redacted] or [redacted], card [redacted]")
    expect(
      redactPrivate("Call (415) 555-0123; SSN 123-45-6789; released 2026-09-27 at 10:00."),
    ).toBe("Call [redacted]; SSN [redacted]; released 2026-09-27 at 10:00.")
    // Identifiers that merely look like numbers or addresses are project facts and stay.
    expect(
      redactPrivate(
        "Clone git@github.com:acme/otis.git; epoch 1727395200; #1234567890; 162613881344 bytes",
      ),
    ).toBe("Clone git@github.com:acme/otis.git; epoch 1727395200; #1234567890; 162613881344 bytes")
    const { cwd } = await scratch()
    const entry = await remember("workspace", "Deploy uses token=abc123xyz for staging.", cwd)
    expect(entry.text).toBe("Deploy uses token=[redacted] for staging.")
  })

  it("recalls matching facts and past sessions from every workspace, never the current one", async () => {
    const { home, cwd } = await scratch()
    await remember("workspace", "The limiter lives in src/net/limiter.ts.", cwd, undefined, "net")
    await remember("global", "Prefer bun over npm.", cwd)
    const sessions = join(home, "sessions")
    const line = (seq: number, id: string, type: string, at: string, fields: object) =>
      JSON.stringify({ seq, sessionId: id, at, type, ...fields })
    const session = async (dir: string, id: string, title: string, text: string) => {
      await mkdir(join(sessions, dir), { recursive: true })
      await writeFile(
        join(sessions, dir, `${id}.jsonl`),
        [
          line(1, id, "session_started", "2026-09-10T10:00:00.000Z", { version: 1 }),
          line(2, id, "prompt_admitted", "2026-09-10T10:00:01.000Z", {
            promptId: "p",
            message: { role: "user", content: title },
          }),
          line(3, id, "turn_completed", "2026-09-10T10:00:05.000Z", {
            promptId: "p",
            messages: [{ role: "assistant", content: [{ type: "text", text }] }],
          }),
        ].join("\n"),
      )
    }
    await session("workspace", "s-here", "Tune the limiter", "The limiter buckets by workspace.")
    await session(
      "other",
      "s-there",
      "Unrelated cleanup",
      "Limiter key sk-abcdefghijklmnopqrstuvwxyz",
    )
    await session("other", "s-current", "Limiter again", "Current session text.")

    const output = await recall("limiter", cwd, "s-current")
    expect(output).toContain(
      `Remembered (workspace):\n- The limiter lives in src/net/limiter.ts. (net, ${today})`,
    )
    expect(output).not.toContain("Prefer bun")
    expect(output).toContain("Past sessions:")
    expect(output).toContain("2026-09-10 · Tune the limiter (workspace)")
    expect(output).toContain("[redacted]")
    expect(output).not.toContain("Limiter again")
    expect(await recall("zzz", cwd)).toBe("Nothing remembered or recorded matches.")
  })

  it("answers a question in other words than the facts, by any word, whole, most words first", async () => {
    const { cwd } = await scratch()
    const profile = "learner-profile"
    await remember("workspace", "The user built the Otis agent harness.", cwd, undefined, profile)
    await remember("workspace", "The user is new to LLM training.", cwd, undefined, profile)
    await remember("workspace", "Memory lives in the workspace folder.", cwd, undefined, "layout")

    // The query the model sent when asked "what do you know about me": a list of words.
    const output = await recall("user preferences identity setup work history", cwd)
    expect(output.split("\n").slice(0, 3)).toEqual([
      "Remembered (workspace):",
      `- The user built the Otis agent harness. (learner-profile, ${today})`,
      `- The user is new to LLM training. (learner-profile, ${today})`,
    ])
    expect(output).not.toContain("Memory lives")
    // Words match whole: "me" is not "memory". A topic's name reads the topic.
    expect(await recall("me", cwd)).not.toContain("Memory lives")
    expect(await recall("memory", cwd)).toContain("Memory lives")
    expect(await recall("layout", cwd)).toContain("Memory lives")
    // The fact with more of the words comes first.
    const ranked = await recall("training llm user", cwd)
    expect(ranked.indexOf("new to LLM training")).toBeLessThan(ranked.indexOf("agent harness"))
    expect(await recall("", cwd)).toBe("Nothing remembered or recorded matches.")
  })

  it("serves each scope's index as it is on disk, for the prompt, and only where one exists", async () => {
    const { home, cwd } = await scratch()
    expect(await memoryIndex(cwd)).toEqual([])
    await remember("global", "Prefer bun over npm.", cwd, undefined, "setup")
    expect(await memoryIndex(cwd)).toEqual([
      { scope: "global", content: "# Memory: Otis\n\n- [[setup]]\n" },
    ])
    // Hand-written lines in the index reach the prompt untouched.
    await writeFile(
      join(home, "memory", "MEMORY.md"),
      "# Memory\n\nAlways answer in English.\n\n- [[setup]]\n",
    )
    await remember("workspace", "Tests run with bun test.", cwd, undefined, "testing")
    expect((await memoryIndex(cwd)).map(({ scope, content }) => [scope, content])).toEqual([
      ["workspace", `# Memory: ${basename(cwd)}\n\n- [[testing]]\n`],
      ["global", "# Memory\n\nAlways answer in English.\n\n- [[setup]]\n"],
    ])
  })

  it("runs as tools with the turn's session stamped on what it remembers", async () => {
    const { cwd } = await scratch()
    const context = { cwd, sessionId: "s-9" }
    await expect(
      executeToolCall(
        {
          name: "remember",
          input: { fact: "Tests run with bun test.", scope: "workspace", topic: "testing" },
        },
        context,
      ),
    ).resolves.toEqual({
      title: "Remembered (workspace · testing)",
      output: "Tests run with bun test.",
    })
    expect(
      await readFile(join(defaultSessionDirectory(cwd), "memory", "testing.md"), "utf8"),
    ).toContain(`[source: s-9; added: ${today}]`)
    const recalled = await executeToolCall({ name: "recall", input: { query: "bun" } }, context)
    expect(recalled.title).toBe("Recall: bun")
    expect(recalled.output).toContain("Tests run with bun test. (testing")
    await expect(
      executeToolCall({ name: "forget", input: { fact: "bun test", scope: "workspace" } }, context),
    ).resolves.toEqual({
      title: "Forgot (workspace · testing)",
      output: "Tests run with bun test.",
    })
    expect(await listMemory(cwd)).toEqual([])
  })
})

async function scratch() {
  const home = await otisHome("otis-memory-")
  const cwd = join(home, "workspace")
  await mkdir(cwd, { recursive: true })
  return { home, cwd }
}
