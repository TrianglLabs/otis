import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { executeTurn } from "../../src/cli/turn-runner.js"
import { compactionSummaryMessage } from "../../src/core/compaction.js"
import { SteeringInbox } from "../../src/core/steering.js"
import type { ChatMessage, InferenceClient, UserChatMessage } from "../../src/inference/types.js"
import { openSession } from "../../src/storage/session.js"

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
    await session.compactTurn(admission, "Earlier progress.", [admission.message], {}, 0)
    const steering = await session.steerPrompt(admission, "continue")
    const continuation = [steering, answer("Finished.")]
    if (ending === "complete") await session.completeTurn(admission, continuation)
    else await session.interruptTurn(admission, continuation)
    expect((await openSession(options)).replayMessages()).toEqual([
      compactionSummaryMessage("Earlier progress."),
      admission.message,
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
        const prompt = request.messages[0]?.content
        if (typeof prompt === "string" && prompt.startsWith("You are summarizing")) {
          summaries += 1
          const accepted = steering.accept(user(`steering ${summaries}`))
          if (!accepted.accepted) throw new Error("Steering was unexpectedly closed")
          await accepted.persisted
          yield { type: "text_delta", text: `Summary ${summaries}.` }
          return
        }
        requests += 1
        expect(request.messages).not.toContainEqual(queued.message)
        if (requests > 1) expect(request.messages).toContainEqual(user(`steering ${requests - 1}`))
        if (requests < 3) {
          yield { type: "reasoning_delta", field: "reasoning_content", text: "x".repeat(100_000) }
          yield { type: "tool_call", toolCall: { id: `read_${requests}`, name: "read", arguments: "{}" } }
        } else yield { type: "text_delta", text: "Finished." }
      },
    }
    const checkpoints: ChatMessage[][] = []
    const result = await executeTurn({
      input: admission.message,
      agent: {
        client,
        tools: [],
        projectContext: [],
        skills: { skills: [], byName: new Map() },
        steering,
        autoCompactAtTokens: 20_000,
      },
      onCompaction: async (compaction, details, steeringCount) => {
        await session.compactTurn(admission, compaction.summary, compaction.keptMessages, details, steeringCount)
        // A crash here must still leave unconsumed steering and the queued prompt in the session.
        const reopened = await openSession(options)
        checkpoints.push(reopened.replayMessages())
      },
    })
    expect(result.status).toBe("complete")
    if (result.status !== "complete") throw new Error("Turn did not complete")
    await session.completeTurn(admission, result.messages, result.details)
    expect(summaries).toBe(2)
    expect(checkpoints).toEqual([
      [compactionSummaryMessage("Summary 1."), user("steering 1"), queued.message],
      [compactionSummaryMessage("Summary 2."), user("steering 2"), queued.message],
    ])
    const expected = [compactionSummaryMessage("Summary 2."), user("steering 2"), answer("Finished."), queued.message]
    expect(session.replayMessages()).toEqual(expected)
    expect((await openSession(options)).replayMessages()).toEqual(expected)
    await session.completeTurn(queued, [queued.message, answer("Queued task finished.")])
    expect((await openSession(options)).replayMessages()).toEqual([...expected, answer("Queued task finished.")])
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
        if (requests === 1) yield { type: "text_delta", text: "Summary." }
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
      onCompaction: async (compaction, details, steeringCount) => {
        await session.compactTurn(admission, compaction.summary, compaction.keptMessages, details, steeringCount)
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
      compactionSummaryMessage("Summary."),
      admission.message,
    ])
    expect(requests).toBe(ending === "abort" ? 1 : 2)
  })
})

async function sessionOptions() {
  const cwd = await mkdtemp(join(tmpdir(), "otis-compaction-checkpoint-"))
  directories.push(cwd)
  return { cwd, directory: join(cwd, "sessions") }
}
