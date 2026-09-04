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

    await session.completeTurn(admission, messages, { toolActivities })
    const reopened = await openSession({ cwd, directory })

    expect(reopened.replay()).toEqual({ messages, toolActivities, subagents: [] })
    expect(reopened.events.at(-1)).toMatchObject({ type: "turn_completed", toolActivities })
    expect(reopened.events.at(-1)).not.toHaveProperty("subagents")
  })

  it("persists subagent traces with their delegating call and rejects runs without one", async () => {
    const cwd = await trackedTempDir()
    const directory = join(cwd, "sessions")
    const session = await openSession({ cwd, directory })
    const admission = await session.admitPrompt("map the repo")
    const messages = delegationMessages("call_agent")
    const toolActivities = [{ toolCallId: "call_agent", activityKind: "agent" as const, label: "Delegating: Map" }]
    const subagents = [
      {
        toolCallId: "call_agent",
        title: "Map",
        status: "complete" as const,
        messages: [
          { role: "user" as const, content: "Map the repo." },
          {
            role: "assistant" as const,
            content: [
              { type: "tool_call" as const, toolCall: { id: "read_1", name: "read", arguments: '{"path":"a.ts"}' } },
            ],
          },
          { role: "tool" as const, toolCallId: "read_1", content: "a" },
          { role: "assistant" as const, content: [{ type: "text" as const, text: "Report." }] },
        ],
        toolActivities: [{ toolCallId: "read_1", activityKind: "file_read" as const, label: "Reading files: a.ts" }],
        durationMs: 1200,
      },
    ]

    await session.completeTurn(admission, messages, { toolActivities, subagents })
    const reopened = await openSession({ cwd, directory })
    expect(reopened.replay()).toEqual({ messages, toolActivities, subagents })

    const orphan = join(cwd, "orphan.jsonl")
    await writeFile(orphan, turnFile(messages, { subagents: [{ ...subagents[0], toolCallId: "call_missing" }] }))
    await expect(readSessionEvents(orphan)).rejects.toThrow("subagent run did not match an agent tool call")

    const notAgent = join(cwd, "not-agent.jsonl")
    await writeFile(
      notAgent,
      turnFile(toolMessages("call_edit", "a.ts"), { subagents: [{ ...subagents[0], toolCallId: "call_edit" }] }),
    )
    await expect(readSessionEvents(notAgent)).rejects.toThrow("subagent run did not match an agent tool call")
  })

  it("rejects malformed subagent runs", async () => {
    const cwd = await trackedTempDir()
    const messages = delegationMessages("call_agent")
    const run = { toolCallId: "call_agent", title: "Map", status: "complete", messages: [] }
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...run, title: " " }, "subagent run title must be a non-empty string"],
      [{ ...run, status: "running" }, "subagent run status was invalid"],
      [{ ...run, durationMs: -1 }, "subagent run durationMs must be a non-negative integer"],
      [{ ...run, messages: [{ role: "system" }] }, "messages must be chat messages"],
      [
        { ...run, toolActivities: [{ toolCallId: "read_x", activityKind: "file_read", label: "Reading" }] },
        "tool activity did not match a tool call",
      ],
    ]

    for (const [index, [subagent, error]] of cases.entries()) {
      const path = join(cwd, `bad-${index}.jsonl`)
      await writeFile(path, turnFile(messages, { subagents: [subagent] }))
      await expect(readSessionEvents(path)).rejects.toThrow(error)
    }
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
    await session.completeTurn(admission, toolMessages("call_old", "old.ts", "edit old.ts"), {
      toolActivities: [toolActivity("call_old", "old.ts", "old diff")],
    })

    const keptMessages = toolMessages("call_kept", "kept.ts").slice(1)
    const keptActivities = [toolActivity("call_kept", "kept.ts", "kept diff")]

    await session.compact("Summary", keptMessages, { toolActivities: keptActivities })

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

function delegationMessages(toolCallId: string): ChatMessage[] {
  return [
    { role: "user", content: "map the repo" },
    {
      role: "assistant",
      content: [
        {
          type: "tool_call",
          toolCall: { id: toolCallId, name: "agent", arguments: '{"description":"Map","prompt":"List."}' },
        },
      ],
    },
    { role: "tool", toolCallId, content: "agent: Map\n\nReport." },
    { role: "assistant", content: [{ type: "text", text: "Done." }] },
  ]
}

function turnFile(messages: ChatMessage[], details: Record<string, unknown>) {
  const events = [
    { seq: 1, sessionId: "default", at: "now", type: "session_started", version: 1 },
    { seq: 2, sessionId: "default", at: "later", type: "turn_completed", promptId: "prompt_1", messages, ...details },
  ]
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`
}

async function trackedTempDir() {
  const path = await mkdtemp(join(tmpdir(), "otis-session-activity-"))
  tempDirs.push(path)
  return path
}
