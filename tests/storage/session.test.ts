import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ChatMessage } from "../../src/inference/types.js"
import {
  createSession,
  defaultSessionDirectory,
  deleteSession,
  listSessions,
  openSession,
  readSessionEvents,
  replaySessionMessages,
} from "../../src/storage/session.js"

const tempDirs: string[] = []
const originalOtisHome = process.env.OTIS_HOME

afterEach(async () => {
  if (originalOtisHome === undefined) delete process.env.OTIS_HOME
  else process.env.OTIS_HOME = originalOtisHome
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("JsonlSession", () => {
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
    expect(session.events.map((event) => event.type)).toEqual(["session_started", "prompt_admitted", "turn_completed"])
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
      { role: "assistant", content: [{ type: "text", text: "I started with the implementation." }] },
      { role: "user", content: "focus on tests" },
      { role: "assistant", content: [{ type: "text", text: "The tests need one change." }] },
    ]

    await session.completeTurn(active, activeMessages)

    expect(session.replayMessages()).toEqual([...activeMessages, queued.message])
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
        { type: "image" as const, data: "iVBORw==", mimeType: "image/png" as const, name: "screen.png", sizeBytes: 4 },
        { type: "text" as const, text: "Describe this" },
      ],
    }
    const admission = await session.admitPrompt(message)
    const turnMessages: ChatMessage[] = [message, { role: "assistant", content: [{ type: "text", text: "A screen." }] }]

    await session.completeTurn(admission, turnMessages)
    const reopened = await openSession({ cwd, directory })

    expect(reopened.replayMessages()).toEqual(turnMessages)
    expect(reopened.events.at(-1)).toMatchObject({ type: "turn_completed", messages: turnMessages.slice(1) })
  })

  it("continues sequence numbers when reopening a session", async () => {
    const cwd = await trackedTempDir()
    const directory = join(cwd, "sessions")
    const first = await openSession({ cwd, directory })
    await first.admitPrompt("first")

    const second = await openSession({ cwd, directory })
    await second.admitPrompt("second")

    expect(second.events.map((event) => event.seq)).toEqual([1, 2, 3])
    expect(replaySessionMessages(second.events)).toEqual([
      { role: "user", content: "first" },
      { role: "user", content: "second" },
    ])
  })

  it("persists and replays interrupted turn progress", async () => {
    const cwd = await trackedTempDir()
    const directory = join(cwd, "sessions")
    const session = await openSession({ cwd, directory })
    const admission = await session.admitPrompt("add the setting")
    const messages: ChatMessage[] = [
      { role: "user", content: "add the setting" },
      { role: "assistant", content: [{ type: "text", text: "I updated the client and added a test." }] },
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
            { role: "assistant", content: [{ type: "reasoning", field: "reasoning_content", text: "Legacy" }] },
          ],
        }),
      ].join("\n")}\n`,
      "utf8",
    )

    await expect(readSessionEvents(path)).resolves.toMatchObject([
      { type: "session_started" },
      {
        type: "turn_completed",
        messages: [{ role: "assistant", content: [{ type: "reasoning", field: "reasoning_content", text: "Legacy" }] }],
      },
    ])
  })

  it("rejects malformed JSONL with a line number", async () => {
    const cwd = await trackedTempDir()
    const path = join(cwd, "bad.jsonl")
    await writeFile(path, '{"seq":1,"sessionId":"default","at":"now","type":"session_started","version":1}\nnope\n')

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

      await first.admitPrompt("older session\nwith details")
      vi.setSystemTime(new Date("2026-01-01T00:00:00.001Z"))
      await second.admitPrompt("newer session")

      const sessions = await listSessions({ cwd, directory })

      expect(
        sessions.map((session) => ({ id: session.id, title: session.title, messageCount: session.messageCount })),
      ).toEqual([
        { id: "second", title: "newer session", messageCount: 1 },
        { id: "first", title: "older session", messageCount: 1 },
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
      { id: "valid", title: "valid session", messageCount: 1 },
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

  it("persists a compaction event and replays summary + kept messages", async () => {
    const cwd = await trackedTempDir()
    const session = await openSession({ cwd, directory: join(cwd, "sessions") })

    const admission = await session.admitPrompt("hello")
    await session.completeTurn(admission, [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ])

    const keptMessages: ChatMessage[] = [{ role: "assistant", content: [{ type: "text", text: "hi" }] }]
    await session.compact("Summary of the conversation", keptMessages)

    expect(session.events.map((event) => event.type)).toEqual([
      "session_started",
      "prompt_admitted",
      "turn_completed",
      "compacted",
    ])

    const replayed = session.replayMessages()
    expect(replayed).toHaveLength(2)
    expect(replayed[0]).toEqual({
      role: "user",
      content: "[Compacted conversation summary]\n\nSummary of the conversation",
    })
    expect(replayed[1]).toEqual(keptMessages[0])
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
      [],
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

    await session.compact("Summary", [{ role: "assistant", content: [{ type: "text", text: "reply" }] }])

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

  it("falls back to first user message when no title_renamed event exists", async () => {
    const cwd = await trackedTempDir()
    const directory = join(cwd, "sessions")
    const session = await openSession({ cwd, directory, sessionId: "titled" })

    await session.admitPrompt("my question")
    expect(session.hasTitle()).toBe(false)
    expect(session.title()).toBe("my question")
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
  })

  it("does not throw when deleting a non-existent session", async () => {
    const cwd = await trackedTempDir()
    const directory = join(cwd, "sessions")
    await expect(deleteSession({ cwd, directory, sessionId: "missing" })).resolves.toBeUndefined()
  })
})

async function trackedTempDir() {
  const path = await mkdtemp(join(tmpdir(), "otis-session-"))
  tempDirs.push(path)
  return path
}
