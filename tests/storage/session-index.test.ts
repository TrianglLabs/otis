import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { openSession } from "../../src/storage/session.js"
import { readSessionEvents } from "../../src/storage/session-events.js"
import { readSessionDigest, sessionView } from "../../src/storage/session-index.js"

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

    const plain = await readSessionDigest(file)
    expect(await readSessionDigest(file)).toBe(plain)
    expect(plain.summary).toMatchObject({ title: "first question", state: "pending" })
    // Listings leave the message text on disk; a search asks for it, and that read serves both.
    expect(plain.texts).toBeUndefined()
    const digest = await readSessionDigest(file, true)
    expect(digest).not.toBe(plain)
    expect(digest.texts).toEqual(["first question"])
    expect(await readSessionDigest(file)).toBe(digest)
    expect(await readSessionDigest(file, true)).toBe(digest)

    await session.completeTurn(admission, [
      admission.message,
      { role: "assistant", content: [{ type: "text", text: "an  answer\nhere" }] },
    ])
    const next = await readSessionDigest(file, true)
    expect(next).not.toBe(digest)
    expect(next.summary).toMatchObject({ messageCount: 2, state: "complete" })
    expect(next.texts).toEqual(["first question", "an answer here"])
    expect(next.activity.map((event) => event.type)).toEqual(["prompt_admitted", "turn_completed"])
    expect(next.activity[1]).toMatchObject({ subagents: 0 })

    // Delegated runs count on the turn that ends them, including runs archived at a compaction.
    const second = await session.admitPrompt("delegate")
    const delegation = (toolCallId: string) => ({
      messages: [
        {
          role: "assistant" as const,
          content: [
            {
              type: "tool_call" as const,
              toolCall: { id: toolCallId, name: "agent", arguments: "{}" },
            },
          ],
        },
        { role: "tool" as const, toolCallId, content: "agent: Survey\n\nDone." },
      ],
      subagents: [{ toolCallId, title: "Survey", status: "complete" as const, messages: [] }],
    })
    await session.compactTurn(second, "summary", [], {}, 1, delegation("call_1"))
    const later = delegation("call_2")
    await session.completeTurn(second, later.messages, { subagents: later.subagents })
    expect((await readSessionDigest(file)).activity.at(-1)).toMatchObject({
      type: "turn_completed",
      subagents: 2,
    })
  })
})

describe("session views", () => {
  it("keeps the last arrangement worth a line and lists company only when there is some", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "otis-session-index-"))
    tempDirs.push(cwd)
    const options = { cwd, directory: join(cwd, "sessions") }
    const session = await openSession(options)
    await session.admitPrompt("first question")
    const file = join(options.directory, `${session.id}.jsonl`)
    const self = { id: session.id, dirName: "ws" }
    const alone = { members: [self], axis: "row" as const }
    const pair = { members: [self, { id: "other", dirName: "ws" }], axis: "column" as const }

    // Alone is how every session starts, so the first word of it says nothing.
    await session.arrangeView(alone)
    expect(session.view()).toBeUndefined()
    expect((await readSessionDigest(file)).summary.view).toBeUndefined()

    await session.arrangeView(pair)
    await session.arrangeView(pair)
    expect(session.view()).toEqual(pair)
    const events = await readSessionEvents(file)
    expect(events.filter((event) => event.type === "view_arranged")).toHaveLength(1)
    expect(sessionView(events)).toEqual(pair)
    expect((await readSessionDigest(file)).summary.view).toEqual(pair)

    // Back to alone is worth recording; listings then show no company.
    await session.arrangeView(alone)
    expect(session.view()).toEqual(alone)
    expect((await readSessionDigest(file)).summary.view).toBeUndefined()
  })
})
