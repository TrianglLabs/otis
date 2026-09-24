import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { openSession } from "../../src/storage/session.js"
import { readSessionDigest } from "../../src/storage/session-index.js"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("readSessionDigest", () => {
  it("reads a session file once per version", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "otis-session-index-"))
    tempDirs.push(cwd)
    const options = { cwd, directory: join(cwd, "sessions") }
    const session = await openSession(options)
    const admission = await session.admitPrompt("first question")
    const file = join(options.directory, `${session.id}.jsonl`)

    const digest = await readSessionDigest(file)
    expect(await readSessionDigest(file)).toBe(digest)
    expect(digest.summary).toMatchObject({ title: "first question", state: "pending" })
    expect(digest.texts).toEqual(["first question"])

    await session.completeTurn(admission, [
      admission.message,
      { role: "assistant", content: [{ type: "text", text: "an  answer\nhere" }] },
    ])
    const next = await readSessionDigest(file)
    expect(next).not.toBe(digest)
    expect(next.summary).toMatchObject({ messageCount: 2, state: "complete" })
    expect(next.texts).toEqual(["first question", "an answer here"])
    expect(next.activity.map((event) => event.type)).toEqual(["prompt_admitted", "turn_completed"])
  })
})
