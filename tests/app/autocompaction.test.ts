import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { executeTurn } from "../../src/app/turn-runner.js"
import { compactionSummaryMessage } from "../../src/core/compaction.js"
import { SteeringInbox } from "../../src/core/steering.js"
import type { ChatMessage, InferenceClient, UserChatMessage } from "../../src/inference/types.js"
import { openSession } from "../../src/storage/session.js"
import { TOOL_DEFINITIONS } from "../../src/tools/index.js"
import { summaryFixture } from "../support/compaction.js"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})
const user = (content: string): UserChatMessage => ({ role: "user", content })
const answer = (text: string): ChatMessage => ({ role: "assistant", content: [{ type: "text", text }] })

describe("compaction checkpoints during active turns", () => {
  it.each(["complete", "interrupt"])("preserves steering identical to the initial prompt on %s", async (ending) => {
    const options = await sessionOptions()
    const session = await openSession(options)
    const admission = await session.admitPrompt("continue")
    await session.compactTurn(admission, "Earlier progress.", [admission.message], {}, 0, {
      messages: [admission.message],
    })
    const steering = await session.steerPrompt(admission, "continue")
    const continuation = [steering, answer("Finished.")]
    if (ending === "complete") await session.completeTurn(admission, continuation)
    else await session.interruptTurn(admission, continuation)
    // Released session files have checkpoints without the archived turn segment.
    const lines = session.events.map((event) =>
      JSON.stringify(event.type === "compacted" ? { ...event, turn: undefined } : event),
    )
    await writeFile(session.filePath, `${lines.join("\n")}\n`)
    expect((await openSession(options)).replayMessages()).toEqual([
      compactionSummaryMessage("Earlier progress."),
      admission.message,
      steering,
      answer("Finished."),
    ])
    expect((await openSession(options)).replayTranscript().messages).toEqual([
      admission.message,
      compactionSummaryMessage("Earlier progress."),
      steering,
      answer("Finished."),
    ])
  })

  it("replays repeated checkpoints, new steering, and queued prompts in order without duplicates", async () => {
    const options = await sessionOptions()
    const session = await openSession(options)
    const admission = await session.admitPrompt("task")
    const queued = await session.admitPrompt("queued task")
    const steering = new SteeringInbox(async (message) => {
      await session.steerPrompt(admission, message)
    })
    let requests = 0
    let summaries = 0
    const client: InferenceClient = {
      model: "fake",
      complete: vi.fn(),
      streamChat: async function* (request) {
        if (request.systemPrompt?.startsWith("You are a conversation summarizer")) {
          summaries += 1
          const accepted = steering.accept(user(`steering ${summaries}`))
          if (!accepted.accepted) throw new Error("Steering was unexpectedly closed")
          await accepted.persisted
          yield { type: "text_delta", text: summaryFixture(`Summary ${summaries}.`) }
          return
        }
        requests += 1
        expect(request.messages).not.toContainEqual(queued.message)
        if (requests > 1) expect(request.messages).toContainEqual(user(`steering ${requests - 1}`))
        if (requests < 3) {
          yield { type: "reasoning_delta", field: "reasoning_content", text: "x".repeat(100_000) }
          yield {
            type: "tool_call",
            toolCall: { id: `read_${requests}`, name: "read", arguments: '{"path":"missing-fixture.txt"}' },
          }
        } else yield { type: "text_delta", text: "Finished." }
      },
    }
    const checkpoints: ChatMessage[][] = []
    const segments: ChatMessage[][] = []
    const result = await executeTurn({
      input: admission.message,
      agent: {
        client,
        cwd: options.cwd,
        tools: TOOL_DEFINITIONS.filter((tool) => tool.name === "read"),
        projectContext: [],
        skills: { skills: [], byName: new Map() },
        steering,
        autoCompactAtTokens: 20_000,
      },
      onCompaction: async (compaction, details, steeringCount, turn) => {
        segments.push([...turn.messages, compactionSummaryMessage(compaction.summary)])
        await session.compactTurn(admission, compaction.summary, compaction.keptMessages, details, steeringCount, turn)
        // A crash here must still leave unconsumed steering and the queued prompt in the session.
        const reopened = await openSession(options)
        checkpoints.push(reopened.replayMessages())
        expect(reopened.replayTranscript().messages).toEqual([
          ...segments.flat(),
          user(`steering ${summaries}`),
          queued.message,
        ])
      },
    })
    expect(result.status).toBe("complete")
    if (result.status !== "complete") throw new Error("Turn did not complete")
    await session.completeTurn(admission, result.messages, result.details)
    expect(summaries).toBe(2)
    expect(checkpoints).toEqual([
      [compactionSummaryMessage(summaryFixture("Summary 1.")), user("steering 1"), queued.message],
      [compactionSummaryMessage(summaryFixture("Summary 2.")), user("steering 2"), queued.message],
    ])
    const expected = [
      compactionSummaryMessage(summaryFixture("Summary 2.")),
      user("steering 2"),
      answer("Finished."),
      queued.message,
    ]
    expect(session.replayMessages()).toEqual(expected)
    expect((await openSession(options)).replayMessages()).toEqual(expected)
    await session.completeTurn(queued, [queued.message, answer("Queued task finished.")])
    expect((await openSession(options)).replayMessages()).toEqual([...expected, answer("Queued task finished.")])
    const scrollback = (await openSession(options)).replayTranscript()
    expect(scrollback.messages).toEqual([
      ...segments.flat(),
      user("steering 2"),
      answer("Finished."),
      queued.message,
      answer("Queued task finished."),
    ])
    expect(scrollback.toolActivities.map((activity) => activity.toolCallId)).toEqual(["read_1", "read_2"])
  })

  it.each(["abort", "error"])("retains the checkpoint and only appends the continuation after %s", async (ending) => {
    const options = await sessionOptions()
    const session = await openSession(options)
    const previous = await session.admitPrompt("old task")
    const history: ChatMessage[] = [
      previous.message,
      {
        role: "assistant",
        content: [
          { type: "reasoning", field: "reasoning_content", text: "x".repeat(100_000) },
          { type: "text", text: "Done." },
        ],
      },
    ]
    await session.completeTurn(previous, history)
    const admission = await session.admitPrompt("continue")
    const controller = new AbortController()
    let requests = 0
    const client: InferenceClient = {
      model: "fake",
      complete: vi.fn(),
      streamChat: async function* () {
        requests += 1
        if (requests === 1) yield { type: "text_delta", text: summaryFixture("Summary.") }
        else throw new Error("Provider unavailable")
      },
    }
    const result = await executeTurn({
      input: admission.message,
      history,
      agent: {
        client,
        tools: [],
        projectContext: [],
        skills: { skills: [], byName: new Map() },
        autoCompactAtTokens: 20_000,
        signal: controller.signal,
      },
      onCompaction: async (compaction, details, steeringCount, turn) => {
        await session.compactTurn(admission, compaction.summary, compaction.keptMessages, details, steeringCount, turn)
      },
      onEvent: (event) => {
        if (ending === "abort" && event.type === "compaction" && event.phase === "complete") controller.abort()
      },
    })
    expect(result.status).toBe(ending === "abort" ? "interrupted" : "error")
    if (result.status !== "interrupted" && result.status !== "error") throw new Error("Unexpected result")
    await session.interruptTurn(admission, result.messages, result.details)
    expect(result.messages).toEqual([])
    expect((await openSession(options)).replayMessages()).toEqual([
      compactionSummaryMessage(summaryFixture("Summary.")),
      admission.message,
    ])
    expect(requests).toBe(ending === "abort" ? 1 : 2)
    expect((await openSession(options)).replayTranscript().messages).toEqual([
      ...history,
      admission.message,
      compactionSummaryMessage(summaryFixture("Summary.")),
    ])
  })
})

async function sessionOptions() {
  const cwd = await mkdtemp(join(tmpdir(), "otis-compaction-checkpoint-"))
  directories.push(cwd)
  return { cwd, directory: join(cwd, "sessions") }
}
