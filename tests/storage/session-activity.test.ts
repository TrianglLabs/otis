import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { ChatMessage } from "../../src/inference/types.js"
import { openSession, readSessionEvents } from "../../src/storage/session.js"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("session tool activity", () => {
  it("persists tool activities and diffs across a close and reopen", async () => {
    const cwd = await trackedTempDir()
    const directory = join(cwd, "sessions")
    const session = await openSession({ cwd, directory })
    const admission = await session.admitPrompt("update the file")
    const messages: ChatMessage[] = [
      { role: "user", content: "update the file" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll edit it." },
          {
            type: "tool_call",
            toolCall: { id: "call_edit", name: "edit", arguments: '{"path":"app.ts","old":"a","new":"b"}' },
          },
        ],
      },
      { role: "tool", toolCallId: "call_edit", content: "edit: app.ts\n\nupdated" },
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
    ]
    const toolActivities = [
      {
        toolCallId: "call_edit",
        activityKind: "file_edit" as const,
        label: "Editing file: app.ts",
        diff: "--- app.ts\n+++ app.ts\n-a\n+b",
      },
    ]

    await session.completeTurn(admission, messages, toolActivities)
    const reopened = await openSession({ cwd, directory })

    expect(reopened.replay()).toEqual({ messages, toolActivities })
    expect(reopened.events.at(-1)).toMatchObject({ type: "turn_completed", toolActivities })
  })

  it("rejects malformed persisted tool activity metadata", async () => {
    const cwd = await trackedTempDir()
    const path = join(cwd, "bad-activity.jsonl")
    const events = [
      { seq: 1, sessionId: "default", at: "now", type: "session_started", version: 1 },
      {
        seq: 2,
        sessionId: "default",
        at: "later",
        type: "turn_completed",
        promptId: "prompt_1",
        messages: [],
        toolActivities: [{ toolCallId: "call_1", activityKind: "unknown", label: "Doing something" }],
      },
    ]
    await writeFile(path, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`)

    await expect(readSessionEvents(path)).rejects.toThrow("tool activity activityKind was invalid")
  })

  it("replaces prior tool activities with the activities retained by compaction", async () => {
    const cwd = await trackedTempDir()
    const session = await openSession({ cwd, directory: join(cwd, "sessions") })
    const admission = await session.admitPrompt("edit old.ts")
    await session.completeTurn(admission, toolMessages("call_old", "old.ts", "edit old.ts"), [
      toolActivity("call_old", "old.ts", "old diff"),
    ])

    const keptMessages = toolMessages("call_kept", "kept.ts").slice(1)
    const keptActivities = [toolActivity("call_kept", "kept.ts", "kept diff")]

    await session.compact("Summary", keptMessages, keptActivities)

    expect(session.replay().toolActivities).toEqual(keptActivities)
    expect(session.replay().messages).toEqual([
      { role: "user", content: "[Compacted conversation summary]\n\nSummary" },
      ...keptMessages,
    ])
  })
})

function toolMessages(toolCallId: string, path: string, prompt = "prompt"): ChatMessage[] {
  return [
    { role: "user", content: prompt },
    {
      role: "assistant",
      content: [
        {
          type: "tool_call",
          toolCall: { id: toolCallId, name: "edit", arguments: `{"path":"${path}","old":"a","new":"b"}` },
        },
      ],
    },
    { role: "tool", toolCallId, content: "updated" },
  ]
}

function toolActivity(toolCallId: string, path: string, diff: string) {
  return { toolCallId, activityKind: "file_edit" as const, label: `Editing file: ${path}`, diff }
}

async function trackedTempDir() {
  const path = await mkdtemp(join(tmpdir(), "otis-session-activity-"))
  tempDirs.push(path)
  return path
}
