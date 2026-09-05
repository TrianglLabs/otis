import { describe, expect, it, vi } from "vitest"
import { Application } from "../../src/app/application.js"
import type { ConversationHooks } from "../../src/app/conversation.js"
import type { TurnResult, TurnRunnerOptions } from "../../src/app/turn-runner.js"
import { useOtisHome } from "./support/otis-home.js"

const mocks = vi.hoisted(() => ({ executeTurn: vi.fn() }))
vi.mock("../../src/app/turn-runner.js", () => ({ executeTurn: mocks.executeTurn }))

const isolate = useOtisHome()

describe("Application", () => {
  it("composes workspace, session, and model coordinators without a frontend", async () => {
    const home = await isolate("otis-app-")

    const app = await Application.create({
      cwd: home,
      env: { FIREWORKS_API_KEY: "fw_test" },
    })

    expect(app.cwd).toBe(home)
    expect(app.fireworksApiKey).toBe("fw_test")
    expect(app.settings.model).toBeUndefined()
    expect(app.settings.theme).toBeUndefined()
    expect(app.transcript.entries).toEqual([])
    expect(app.subagents.all).toEqual([])
    expect(app.sessions.current).toBeUndefined()
    expect(app.conversation.busy).toBe(false)
    expect(app.createPermissionPolicy()).toBeDefined()
    await app.shutdown()
  })

  it("shutdown finishes while a permission prompt is unanswered", async () => {
    const home = await isolate("otis-app-quit-")
    const app = await Application.create({
      cwd: home,
      env: { FIREWORKS_API_KEY: "fw_test" },
    })
    app.models.client = { model: "fake", streamChat: vi.fn(), complete: vi.fn() }
    app.models.selectedProvider = "fireworks"

    mocks.executeTurn.mockImplementation(async (options: TurnRunnerOptions): Promise<TurnResult> => {
      await options.agent.onPermissionRequest?.({
        call: { name: "bash", input: { command: "ls" } },
        decision: { effect: "ask", resources: [] },
      })
      return { status: "interrupted", messages: [], details: {} }
    })

    const started = app.conversation.start({ role: "user", content: "run ls" }, hangingHooks())
    await vi.waitFor(() => expect(app.conversation.busy).toBe(true))
    await app.shutdown()
    expect(app.conversation.busy).toBe(false)
    await expect(started).resolves.toMatchObject({ status: "interrupted" })
  })
})

function hangingHooks(): ConversationHooks {
  return {
    sink: {
      renderTranscript: () => {},
      renderSubagents: () => {},
      setPhase: () => {},
      startBusy: () => {},
      stopBusy: () => {},
    },
    debug: false,
    onContext: () => {},
    onDiff: () => {},
    onPermissionRequest: () => new Promise(() => {}),
    onCompletion: () => {},
  }
}
