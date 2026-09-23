import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ChatMessage } from "../../src/inference/types.js"
import {
  createSession,
  deleteSession,
  listSessions,
  openSession,
} from "../../src/storage/session.js"
import { readSessionEvents, replaySessionMessages } from "../../src/storage/session-events.js"
import { defaultSessionDirectory } from "../../src/storage/session-files.js"

const tempDirs: string[] = []
const originalOtisHome = process.env.OTIS_HOME

afterEach(async () => {
  if (originalOtisHome === undefined) delete process.env.OTIS_HOME
  else process.env.OTIS_HOME = originalOtisHome
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("JsonlSession", () => {
  it("persists execution starts separately from admission and keeps an unanswered prompt out of model history", async () => {
    const cwd = await trackedTempDir()
    const options = { cwd, directory: join(cwd, "sessions") }
    const session = await openSession(options)
    const admission = await session.admitPrompt("queued work")
    await session.startTurn(admission)
    await session.interruptTurn(admission, [admission.message])
    const reopened = await openSession(options)
    expect(reopened.events.map((event) => event.type)).toEqual([
      "session_started",
      "prompt_admitted",
      "turn_started",
      "turn_interrupted",
    ])
    expect(reopened.events[2]).toMatchObject({ promptId: admission.promptId })
    expect(reopened.replayMessages()).toEqual([])
    expect(reopened.replayTranscript().messages).toEqual([admission.message])
    expect(reopened.title()).toBe("queued work")
  })

  it("replays an older file whose admitted prompt never ended as scrollback only", async () => {
    const cwd = await trackedTempDir()
    const directory = join(cwd, "sessions")
    await mkdir(directory, { recursive: true })
    const at = "2026-01-01T00:00:00.000Z"
    const huge = { role: "user", content: "huge attachment" }
    const answer = { role: "assistant", content: [{ type: "text", text: "answer" }] }
    const write = (id: string, events: object[]) =>
      writeFile(
        join(directory, `${id}.jsonl`),
        `${events.map((event, index) => JSON.stringify({ seq: index + 1, sessionId: id, at, ...event })).join("\n")}\n`,
      )
    await write("recovered", [
      { type: "session_started", version: 1 },
      { type: "prompt_admitted", promptId: "prompt_1", message: huge },
      { type: "turn_started", promptId: "prompt_1" },
      {
        type: "prompt_admitted",
        promptId: "prompt_2",
        message: { role: "user", content: "second" },
      },
      { type: "turn_started", promptId: "prompt_2" },
      { type: "turn_completed", promptId: "prompt_2", messages: [answer] },
    ])
    await write("stuck", [
      { type: "session_started", version: 1 },
      { type: "prompt_admitted", promptId: "prompt_1", message: huge },
    ])
    const recovered = await openSession({ cwd, directory, sessionId: "recovered" })
    expect(recovered.replayMessages()).toEqual([{ role: "user", content: "second" }, answer])
    expect(recovered.replayTranscript().messages).toEqual([
      huge,
      { role: "user", content: "second" },
      answer,
    ])
    const stuck = await openSession({ cwd, directory, sessionId: "stuck" })
    expect(stuck.replayMessages()).toEqual([])
    expect(stuck.replayTranscript().messages).toEqual([huge])
    expect(stuck.title()).toBe("huge attachment")
  })
  it("admits prompts before completion and replays messages without duplicate users", async () => {
    const cwd = await trackedTempDir()
    const session = await openSession({ cwd, directory: join(cwd, "sessions") })

    const admission = await session.admitPrompt("hello")
    const turnMessages: ChatMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ]

    await session.completeTurn(admission, turnMessages)

    expect(session.events.map((event) => event.seq)).toEqual([1, 2, 3])
    expect(session.events.map((event) => event.type)).toEqual([
      "session_started",
      "prompt_admitted",
      "turn_completed",
    ])
    expect(session.replayMessages()).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ])
  })

  it("persists steering and keeps queued admissions after the completed active turn", async () => {
    const cwd = await trackedTempDir()
    const directory = join(cwd, "sessions")
    const session = await openSession({ cwd, directory })
    const active = await session.admitPrompt("review the project")
    await session.steerPrompt(active, "focus on tests")
    const queued = await session.admitPrompt("then update the docs")
    const activeMessages: ChatMessage[] = [
      active.message,
      {
        role: "assistant",
        content: [{ type: "text", text: "I started with the implementation." }],
      },
      { role: "user", content: "focus on tests" },
      { role: "assistant", content: [{ type: "text", text: "The tests need one change." }] },
    ]

    await session.completeTurn(active, activeMessages)

    // The queued prompt joins model history once its own turn runs.
    expect(session.replayMessages()).toEqual(activeMessages)
    expect(session.replayTranscript().messages).toEqual([...activeMessages, queued.message])
    expect(session.events.map((event) => event.type)).toEqual([
      "session_started",
      "prompt_admitted",
      "prompt_steered",
      "prompt_admitted",
      "turn_completed",
    ])

    await session.completeTurn(queued, [
      queued.message,
      { role: "assistant", content: [{ type: "text", text: "Docs updated." }] },
    ])
    const reopened = await openSession({ cwd, directory })
    expect(reopened.replayMessages()).toEqual([
      ...activeMessages,
      queued.message,
      { role: "assistant", content: [{ type: "text", text: "Docs updated." }] },
    ])
  })

  it("persists structured image prompts and replays them without duplication", async () => {
    const cwd = await trackedTempDir()
    const directory = join(cwd, "sessions")
    const session = await openSession({ cwd, directory })
    const message = {
      role: "user" as const,
      content: [
        {
          type: "image" as const,
          data: "iVBORw==",
          mimeType: "image/png" as const,
          name: "screen.png",
          sizeBytes: 4,
        },
        { type: "text" as const, text: "Describe this" },
      ],
    }
    const admission = await session.admitPrompt(message)
    const turnMessages: ChatMessage[] = [
      message,
      { role: "assistant", content: [{ type: "text", text: "A screen." }] },
    ]

    await session.completeTurn(admission, turnMessages)
    const reopened = await openSession({ cwd, directory })

    expect(reopened.replayMessages()).toEqual(turnMessages)
    expect(reopened.events.at(-1)).toMatchObject({
      type: "turn_completed",
      messages: turnMessages.slice(1),
    })
  })

  it("persists original document assets and extracted text without duplication", async () => {
    const cwd = await trackedTempDir()
    const directory = join(cwd, "sessions")
    const session = await openSession({ cwd, directory })
    const source = Buffer.from("native source")
    const message = {
      role: "user" as const,
      content: [
        {
          type: "document" as const,
          kind: "text" as const,
          data: source.toString("base64"),
          extractedText: "native source",
          mimeType: "text/plain",
          name: "source.txt",
          sizeBytes: source.byteLength,
          sha256: createHash("sha256").update(source).digest("hex"),
          truncated: false,
        },
        { type: "text" as const, text: "Edit this later" },
      ],
    }
    const admission = await session.admitPrompt(message)
    const turnMessages: ChatMessage[] = [
      message,
      { role: "assistant", content: [{ type: "text", text: "Ready." }] },
    ]

    await session.completeTurn(admission, turnMessages)
    const reopened = await openSession({ cwd, directory })

    expect(reopened.replayMessages()).toEqual(turnMessages)
  })

  it("continues sequence numbers when reopening a session", async () => {
    const cwd = await trackedTempDir()
    const directory = join(cwd, "sessions")
    const first = await openSession({ cwd, directory })
    await first.admitPrompt("first")

    const second = await openSession({ cwd, directory })
    await second.admitPrompt("second")

    expect(second.events.map((event) => event.seq)).toEqual([1, 2, 3])
    expect(second.replayTranscript().messages).toEqual([
      { role: "user", content: "first" },
      { role: "user", content: "second" },
    ])
    expect(replaySessionMessages(second.events)).toEqual([])
  })

  it("persists and replays interrupted turn progress", async () => {
    const cwd = await trackedTempDir()
    const directory = join(cwd, "sessions")
    const session = await openSession({ cwd, directory })
    const admission = await session.admitPrompt("add the setting")
    const messages: ChatMessage[] = [
      { role: "user", content: "add the setting" },
      {
        role: "assistant",
        content: [{ type: "text", text: "I updated the client and added a test." }],
      },
    ]

    await session.interruptTurn(admission, messages)
    const reopened = await openSession({ cwd, directory })

    expect(reopened.replayMessages()).toEqual(messages)
    expect(reopened.events.at(-1)).toMatchObject({
      type: "turn_interrupted",
      promptId: admission.promptId,
      messages: messages.slice(1),
    })
  })

  it("persists reasoning trace identity, timing, and provider replay field", async () => {
    const cwd = await trackedTempDir()
    const directory = join(cwd, "sessions")
    const session = await openSession({ cwd, directory })
    const admission = await session.admitPrompt("think")
    const messages: ChatMessage[] = [
      { role: "user", content: "think" },
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            id: "reasoning_1",
            field: "reasoning_content",
            text: "Check the result.",
            startedAt: "2026-08-06T12:00:00.000Z",
            endedAt: "2026-08-06T12:00:00.500Z",
          },
          { type: "text", text: "Done." },
        ],
      },
    ]

    await session.completeTurn(admission, messages)
    const reopened = await openSession({ cwd, directory })

    expect(reopened.replayMessages()).toEqual(messages)
  })

  it("loads reasoning written before trace identity and timing metadata", async () => {
    const cwd = await trackedTempDir()
    const path = join(cwd, "legacy.jsonl")
    await writeFile(
      path,
      `${[
        JSON.stringify({
          seq: 1,
          sessionId: "legacy",
          at: "2026-01-01T00:00:00.000Z",
          type: "session_started",
          version: 1,
        }),
        JSON.stringify({
          seq: 2,
          sessionId: "legacy",
          at: "2026-01-01T00:00:01.000Z",
          type: "turn_completed",
          promptId: "prompt_1",
          messages: [
            {
              role: "assistant",
              content: [{ type: "reasoning", field: "reasoning_content", text: "Legacy" }],
            },
          ],
        }),
      ].join("\n")}\n`,
      "utf8",
    )

    await expect(readSessionEvents(path)).resolves.toMatchObject([
      { type: "session_started" },
      {
        type: "turn_completed",
        messages: [
          {
            role: "assistant",
            content: [{ type: "reasoning", field: "reasoning_content", text: "Legacy" }],
          },
        ],
      },
    ])
  })

  it("rejects malformed JSONL with a line number", async () => {
    const cwd = await trackedTempDir()
    const path = join(cwd, "bad.jsonl")
    await writeFile(
      path,
      '{"seq":1,"sessionId":"default","at":"now","type":"session_started","version":1}\nnope\n',
    )

    await expect(readSessionEvents(path)).rejects.toThrow("Invalid session JSON at line 2")
  })

  it("persists inspectable JSONL events", async () => {
    const cwd = await trackedTempDir()
    const session = await openSession({ cwd, directory: join(cwd, "sessions") })
    await session.admitPrompt("hello")

    const lines = (await readFile(session.filePath, "utf8")).trim().split("\n")

    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1])).toMatchObject({
      seq: 2,
      sessionId: "default",
      type: "prompt_admitted",
      message: { role: "user", content: "hello" },
    })
  })

  it("lists sessions with titles and newest first", async () => {
    vi.useFakeTimers()
    try {
      const cwd = await trackedTempDir()
      const directory = join(cwd, "sessions")
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"))
      const first = await openSession({ cwd, directory, sessionId: "first" })
      const second = await openSession({ cwd, directory, sessionId: "second" })

      const reply: ChatMessage = { role: "assistant", content: [{ type: "text", text: "ok" }] }
      const older = await first.admitPrompt("older session\nwith details")
      await first.completeTurn(older, [older.message, reply])
      vi.setSystemTime(new Date("2026-01-01T00:00:00.001Z"))
      const newer = await second.admitPrompt("newer session")
      await second.completeTurn(newer, [newer.message, reply])

      const sessions = await listSessions({ cwd, directory })

      expect(
        sessions.map((session) => ({
          id: session.id,
          title: session.title,
          messageCount: session.messageCount,
        })),
      ).toEqual([
        { id: "second", title: "newer session", messageCount: 2 },
        { id: "first", title: "older session", messageCount: 2 },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it("skips bad session files when listing sessions", async () => {
    const cwd = await trackedTempDir()
    const directory = join(cwd, "sessions")
    const session = await openSession({ cwd, directory, sessionId: "valid" })
    await session.admitPrompt("valid session")
    await writeFile(join(directory, "bad.jsonl"), "not json\n")
    await writeFile(join(directory, "bad name.jsonl"), "{}\n")

    await expect(listSessions({ cwd, directory })).resolves.toMatchObject([
      { id: "valid", title: "valid session", messageCount: 0 },
    ])
  })

  it("does not hide non-session file system errors while listing sessions", async () => {
    const cwd = await trackedTempDir()
    const directory = join(cwd, "sessions")
    const session = await openSession({ cwd, directory, sessionId: "valid" })
    await session.admitPrompt("valid session")
    await mkdir(join(directory, "directory.jsonl"))

    await expect(listSessions({ cwd, directory })).rejects.toThrow()
  })

  it("creates a distinct empty session", async () => {
    const cwd = await trackedTempDir()
    const session = await createSession({ cwd, directory: join(cwd, "sessions") })

    expect(session.id).toMatch(/^session_\d{8}T\d{6}Z_[a-f0-9-]{8}$/)
    expect(session.events.map((event) => event.type)).toEqual(["session_started"])
    await expect(listSessions({ cwd, directory: join(cwd, "sessions") })).resolves.toMatchObject([
      { id: session.id, title: "Current session", messageCount: 0 },
    ])
  })

  it("uses project-scoped app data for the default session directory", async () => {
    const cwd = join(await trackedTempDir(), "repo with spaces")
    const dataRoot = join(await trackedTempDir(), "data")
    process.env.OTIS_HOME = dataRoot

    const directory = defaultSessionDirectory(cwd)

    expect(directory.startsWith(join(dataRoot, "sessions", "repo-with-spaces-"))).toBe(true)
    expect(directory).not.toContain(join(cwd, ".otis"))
  })

  it("replaces all prior messages on compaction, not just the last turn", async () => {
    const cwd = await trackedTempDir()
    const session = await openSession({ cwd, directory: join(cwd, "sessions") })

    const first = await session.admitPrompt("first")
    await session.completeTurn(first, [
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "first reply" }] },
    ])

    const second = await session.admitPrompt("second")
    await session.completeTurn(second, [
      { role: "user", content: "second" },
      { role: "assistant", content: [{ type: "text", text: "second reply" }] },
    ])

    const keptMessages: ChatMessage[] = [{ role: "user", content: "second" }]
    await session.compact("Compacted summary", keptMessages)

    expect(session.events.map((event) => event.type)).toEqual([
      "session_started",
      "prompt_admitted",
      "turn_completed",
      "prompt_admitted",
      "turn_completed",
      "compacted",
    ])

    const replayed = session.replayMessages()
    // Only the compaction summary + kept messages — no traces of "first" or "first reply".
    expect(replayed).toEqual([
      { role: "user", content: "[Compacted conversation summary]\n\nCompacted summary" },
      { role: "user", content: "second" },
    ])
  })

  it("preserves prompts admitted after a compaction snapshot", async () => {
    const cwd = await trackedTempDir()
    const session = await openSession({ cwd, directory: join(cwd, "sessions") })
    const original = await session.admitPrompt("original")
    await session.completeTurn(original, [
      original.message,
      { role: "assistant", content: [{ type: "text", text: "original reply" }] },
    ])
    const throughSeq = session.events.at(-1)?.seq
    const queued = await session.admitPrompt("queued during compaction")

    await session.compact(
      "Original turn summary",
      [{ role: "assistant", content: [{ type: "text", text: "original reply" }] }],
      {},
      throughSeq,
    )
    await session.completeTurn(queued, [
      queued.message,
      { role: "assistant", content: [{ type: "text", text: "queued reply" }] },
    ])

    expect(session.replayMessages()).toEqual([
      { role: "user", content: "[Compacted conversation summary]\n\nOriginal turn summary" },
      { role: "assistant", content: [{ type: "text", text: "original reply" }] },
      queued.message,
      { role: "assistant", content: [{ type: "text", text: "queued reply" }] },
    ])
  })

  it("continues appending events after a compaction", async () => {
    const cwd = await trackedTempDir()
    const session = await openSession({ cwd, directory: join(cwd, "sessions") })

    const first = await session.admitPrompt("original")
    await session.completeTurn(first, [
      { role: "user", content: "original" },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
    ])

    await session.compact("Summary", [
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
    ])

    const after = await session.admitPrompt("after compaction")
    await session.completeTurn(after, [
      { role: "user", content: "after compaction" },
      { role: "assistant", content: [{ type: "text", text: "post-compaction reply" }] },
    ])

    const replayed = session.replayMessages()
    expect(replayed).toEqual([
      { role: "user", content: "[Compacted conversation summary]\n\nSummary" },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
      { role: "user", content: "after compaction" },
      { role: "assistant", content: [{ type: "text", text: "post-compaction reply" }] },
    ])
  })

  it("skips compaction summary messages when deriving a session title", async () => {
    const cwd = await trackedTempDir()
    const directory = join(cwd, "sessions")
    const session = await openSession({ cwd, directory, sessionId: "titled" })

    const admission = await session.admitPrompt("original question")
    await session.completeTurn(admission, [
      { role: "user", content: "original question" },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
    ])

    await session.compact("Summary", [
      { role: "user", content: "follow up question" },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
    ])

    const sessions = await listSessions({ cwd, directory })
    expect(sessions).toHaveLength(1)
    expect(sessions[0].title).toBe("follow up question")
  })

  it("caps a long first-message title at a word boundary", async () => {
    const cwd = await trackedTempDir()
    const directory = join(cwd, "sessions")
    const session = await openSession({ cwd, directory, sessionId: "rambling" })

    const longPrompt =
      "please refactor the entire renderer layer of the desktop app and also rewrite all of the session storage code while you are at it"
    const admission = await session.admitPrompt(longPrompt)
    await session.completeTurn(admission, [
      { role: "user", content: longPrompt },
      { role: "assistant", content: [{ type: "text", text: "on it" }] },
    ])

    const sessions = await listSessions({ cwd, directory })
    expect(sessions[0].title).toBe("please refactor the entire renderer layer of the desktop…")
    expect(sessions[0].title.length).toBeLessThanOrEqual(61)
  })

  it("hard-cuts a long first-message title with no spaces", async () => {
    const cwd = await trackedTempDir()
    const directory = join(cwd, "sessions")
    const session = await openSession({ cwd, directory, sessionId: "url" })

    const longUrl = `https://example.com/${"a".repeat(120)}`
    const admission = await session.admitPrompt(longUrl)
    await session.completeTurn(admission, [
      { role: "user", content: longUrl },
      { role: "assistant", content: [{ type: "text", text: "on it" }] },
    ])

    const sessions = await listSessions({ cwd, directory })
    expect(sessions[0].title).toBe(`${"https://example.com/".padEnd(60, "a")}…`)
  })

  it("persists and replays a renamed title", async () => {
    const cwd = await trackedTempDir()
    const directory = join(cwd, "sessions")
    const session = await openSession({ cwd, directory, sessionId: "titled" })

    await session.admitPrompt("original question")
    expect(session.hasTitle()).toBe(false)
    expect(session.title()).toBe("original question")

    await session.renameTitle("Fix parser bug")
    expect(session.hasTitle()).toBe(true)
    expect(session.title()).toBe("Fix parser bug")

    const sessions = await listSessions({ cwd, directory })
    expect(sessions).toHaveLength(1)
    expect(sessions[0].title).toBe("Fix parser bug")
  })

  it("uses the latest renamed title when multiple title_renamed events exist", async () => {
    const cwd = await trackedTempDir()
    const directory = join(cwd, "sessions")
    const session = await openSession({ cwd, directory, sessionId: "titled" })

    await session.admitPrompt("original question")
    await session.renameTitle("First title")
    await session.renameTitle("Second title")

    expect(session.title()).toBe("Second title")

    const sessions = await listSessions({ cwd, directory })
    expect(sessions[0].title).toBe("Second title")
  })

  it("rejects empty title_renamed events", async () => {
    const cwd = await trackedTempDir()
    const path = join(cwd, "bad.jsonl")
    await writeFile(
      path,
      '{"seq":1,"sessionId":"default","at":"now","type":"session_started","version":1}\n' +
        '{"seq":2,"sessionId":"default","at":"now","type":"title_renamed","title":""}\n',
    )

    await expect(readSessionEvents(path)).rejects.toThrow("title must be a non-empty string")
  })

  it("deletes a session file", async () => {
    const cwd = await trackedTempDir()
    const directory = join(cwd, "sessions")
    await openSession({ cwd, directory, sessionId: "to-delete" })
    await deleteSession({ cwd, directory, sessionId: "to-delete" })

    const sessions = await listSessions({ cwd, directory })
    expect(sessions.find((s) => s.id === "to-delete")).toBeUndefined()
    // Deleting a session that no longer exists resolves instead of throwing.
    await expect(deleteSession({ cwd, directory, sessionId: "to-delete" })).resolves.toBeUndefined()
  })
})

async function trackedTempDir() {
  const path = await mkdtemp(join(tmpdir(), "otis-session-"))
  tempDirs.push(path)
  return path
}

describe("session state", () => {
  it("marks a session pending, interrupted, or complete by how its last prompt ended", async () => {
    const cwd = await trackedTempDir()
    const directory = join(cwd, "sessions")
    await mkdir(directory, { recursive: true })
    const at = "2026-01-01T00:00:00.000Z"
    const prompt = { role: "user", content: "go" }
    const write = (id: string, events: object[]) =>
      writeFile(
        join(directory, `${id}.jsonl`),
        `${events.map((event, index) => JSON.stringify({ seq: index + 1, sessionId: id, at, ...event })).join("\n")}\n`,
      )
    await write("done", [
      { type: "session_started", version: 1 },
      { type: "prompt_admitted", promptId: "p1", message: prompt },
      { type: "turn_started", promptId: "p1" },
      { type: "turn_completed", promptId: "p1", messages: [] },
    ])
    await write("stopped", [
      { type: "session_started", version: 1 },
      { type: "prompt_admitted", promptId: "p1", message: prompt },
      { type: "turn_started", promptId: "p1" },
      { type: "turn_interrupted", promptId: "p1", messages: [] },
    ])
    await write("waiting", [
      { type: "session_started", version: 1 },
      { type: "prompt_admitted", promptId: "p1", message: prompt },
      { type: "turn_started", promptId: "p1" },
    ])
    // A later completed prompt supersedes an earlier interruption.
    await write("recovered", [
      { type: "session_started", version: 1 },
      { type: "prompt_admitted", promptId: "p1", message: prompt },
      { type: "turn_interrupted", promptId: "p1", messages: [] },
      { type: "prompt_admitted", promptId: "p2", message: prompt },
      { type: "turn_completed", promptId: "p2", messages: [] },
    ])

    const states = Object.fromEntries(
      (await listSessions({ cwd, directory })).map((session) => [session.id, session.state]),
    )
    expect(states).toEqual({
      done: "complete",
      stopped: "interrupted",
      waiting: "pending",
      recovered: "complete",
    })
  })
})
