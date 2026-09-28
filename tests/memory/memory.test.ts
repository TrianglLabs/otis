import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { forget, listMemory, recall, redactPrivate, remember } from "../../src/memory/memory.js"
import { defaultSessionDirectory } from "../../src/storage/session-files.js"
import { executeToolCall } from "../../src/tools/index.js"
import { useOtisHome } from "../app/support/otis-home.js"

const otisHome = useOtisHome()

describe("memory", () => {
  it("appends dated, stamped facts per scope and forgets by text", async () => {
    const { home, cwd } = await scratch()
    await remember("workspace", "  The limiter lives   in src/net/limiter.ts.  ", cwd, "session-1")
    await remember("global", "Prefer bun over npm.", cwd)
    const today = new Date().toISOString().slice(0, 10)
    expect(await readFile(join(defaultSessionDirectory(cwd), "memory.md"), "utf8")).toBe(
      `- ${today} [session-1]: The limiter lives in src/net/limiter.ts.\n`,
    )
    expect(await listMemory(cwd)).toEqual([
      { scope: "workspace", date: today, text: "The limiter lives in src/net/limiter.ts." },
      { scope: "global", date: today, text: "Prefer bun over npm." },
    ])

    // Hand-written lines count too, without a date, and a missing final newline is tolerated.
    await writeFile(
      join(home, "memory.md"),
      "# Notes\n- Prefer bun over npm.\n- Deploys go through CI.",
    )
    await remember("global", "Releases are tagged from main.", cwd)
    expect((await listMemory(cwd)).map((entry) => entry.text)).toEqual([
      "The limiter lives in src/net/limiter.ts.",
      "Prefer bun over npm.",
      "Deploys go through CI.",
      "Releases are tagged from main.",
    ])
    await expect(forget("global", "go through", cwd)).resolves.toEqual({
      scope: "global",
      text: "Deploys go through CI.",
    })
    await expect(forget("global", "nothing like this", cwd)).rejects.toThrow("Nothing in global")
    await remember("global", "Prefer bun for tests.", cwd)
    await expect(forget("global", "prefer bun", cwd)).rejects.toThrow("matches 2")
    await expect(remember("workspace", "   ", cwd)).rejects.toThrow("nothing to remember")

    // Forgetting the last entry leaves an empty file, not a blank line.
    await forget("workspace", "limiter", cwd)
    expect(await readFile(join(defaultSessionDirectory(cwd), "memory.md"), "utf8")).toBe("")
    await remember("workspace", "Again.", cwd)
    expect(await readFile(join(defaultSessionDirectory(cwd), "memory.md"), "utf8")).toBe(
      `- ${today}: Again.\n`,
    )
  })

  it("moves memory that 0.2.6 left in the project out of it on first use", async () => {
    const { cwd } = await scratch()
    await mkdir(join(cwd, ".otis"))
    await writeFile(join(cwd, ".otis", "memory.md"), "- Old fact.\n")
    expect((await listMemory(cwd)).map((entry) => entry.text)).toEqual(["Old fact."])
    expect(await readFile(join(defaultSessionDirectory(cwd), "memory.md"), "utf8")).toBe(
      "- Old fact.\n",
    )
    await expect(readFile(join(cwd, ".otis", "memory.md"))).rejects.toThrow()
    await expect(readdir(cwd)).resolves.not.toContain(".otis")
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
    await remember("workspace", "The limiter lives in src/net/limiter.ts.", cwd)
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
    expect(output).toContain("Remembered (workspace):\n- ")
    expect(output).toContain("The limiter lives in src/net/limiter.ts.")
    expect(output).not.toContain("Prefer bun")
    expect(output).toContain("Past sessions:")
    expect(output).toContain("2026-09-10 · Tune the limiter (workspace)")
    expect(output).toContain("[redacted]")
    expect(output).not.toContain("Limiter again")
    expect(await recall("zzz", cwd)).toBe("Nothing remembered or recorded matches.")
  })

  it("runs as tools with the turn's session stamped on what it remembers", async () => {
    const { cwd } = await scratch()
    const context = { cwd, sessionId: "s-9" }
    await expect(
      executeToolCall(
        { name: "remember", input: { fact: "Tests run with bun test.", scope: "workspace" } },
        context,
      ),
    ).resolves.toEqual({ title: "Remembered (workspace)", output: "Tests run with bun test." })
    expect(await readFile(join(defaultSessionDirectory(cwd), "memory.md"), "utf8")).toContain(
      "[s-9]: Tests run",
    )
    const recalled = await executeToolCall({ name: "recall", input: { query: "bun" } }, context)
    expect(recalled.title).toBe("Recall: bun")
    expect(recalled.output).toContain("Tests run with bun test.")
    await expect(
      executeToolCall({ name: "forget", input: { fact: "bun test", scope: "workspace" } }, context),
    ).resolves.toEqual({ title: "Forgot (workspace)", output: "Tests run with bun test." })
    expect(await listMemory(cwd)).toEqual([])
  })
})

async function scratch() {
  const home = await otisHome("otis-memory-")
  const cwd = join(home, "workspace")
  await mkdir(cwd, { recursive: true })
  return { home, cwd }
}
