import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { calculateLocalStats } from "../../src/local/stats.js"

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("calculateLocalStats", () => {
  it("derives all home-screen stats from local session events across workspaces", async () => {
    const root = await tempDirectory()
    const now = new Date(2026, 6, 16, 12, 0, 0)
    const yesterday = new Date(2026, 6, 15, 12, 0, 0)

    await writeSession(root, "project-a", "session-a", [
      event(1, "session-a", "session_started", localISO(now, -10), { version: 1 }),
      event(2, "session-a", "prompt_admitted", localISO(now, 0), {
        promptId: "prompt-a",
        message: { role: "user", content: "hello" },
      }),
      event(3, "session-a", "usage_recorded", localISO(now, 1), {
        purpose: "agent",
        promptId: "prompt-a",
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      }),
      event(4, "session-a", "turn_completed", localISO(now, 120), {
        promptId: "prompt-a",
        messages: [{ role: "assistant", content: [{ type: "text", text: "hi" }] }],
      }),
    ])
    await writeSession(root, "project-b", "session-b", [
      event(1, "session-b", "session_started", localISO(yesterday, -10), { version: 1 }),
      event(2, "session-b", "prompt_admitted", localISO(yesterday, 0), {
        promptId: "prompt-b",
        message: { role: "user", content: "hello" },
      }),
      event(3, "session-b", "usage_recorded", localISO(yesterday, 1), {
        purpose: "title",
        usage: { promptTokens: 40, completionTokens: 10, totalTokens: 50 },
      }),
      event(4, "session-b", "turn_completed", localISO(yesterday, 60), {
        promptId: "prompt-b",
        messages: [{ role: "assistant", content: [{ type: "text", text: "hi" }] }],
      }),
    ])
    await writeSession(root, "project-b", "broken", ["not-json"])

    await expect(calculateLocalStats({ sessionsRoot: root, now })).resolves.toEqual({
      streak: 2,
      totalTokens: 200,
      sessionCount: 2,
      avgTokensPerSession: 100,
      avgSessionSeconds: 90,
    })
  })

  it("returns zeros when no local sessions exist", async () => {
    await expect(calculateLocalStats({ sessionsRoot: join(await tempDirectory(), "missing") })).resolves.toEqual({
      streak: 0,
      totalTokens: 0,
      sessionCount: 0,
      avgTokensPerSession: 0,
      avgSessionSeconds: 0,
    })
  })
})

function event(seq: number, sessionId: string, type: string, at: string, fields: Record<string, unknown>) {
  return JSON.stringify({ seq, sessionId, at, type, ...fields })
}

function localISO(day: Date, seconds: number) {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12, 0, seconds).toISOString()
}

async function writeSession(root: string, project: string, session: string, lines: string[]) {
  const directory = join(root, project)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, `${session}.jsonl`), `${lines.join("\n")}\n`, "utf8")
}

async function tempDirectory() {
  const path = await mkdtemp(join(tmpdir(), "otis-stats-"))
  tempDirectories.push(path)
  return path
}
