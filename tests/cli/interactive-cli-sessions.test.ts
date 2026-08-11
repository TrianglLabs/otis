import { describe, expect, it, vi } from "vitest"
import {
  clone,
  getMocks,
  loadCli,
  localSettings,
  settle,
  submit,
  testSession,
} from "./support/interactive-cli-harness.js"

const mocks = getMocks()

describe("CLI session turn handling", () => {
  it("turns a dragged, shell-escaped image path into a multimodal prompt", async () => {
    const session = testSession()
    mocks.createSession.mockResolvedValue(session)
    mocks.loadLocalSettings.mockResolvedValue(localSettings({ modelSupportsImageInput: true }))
    mocks.runAgent.mockImplementationOnce(async function* (input) {
      yield {
        type: "complete",
        messages: [input, { role: "assistant", content: [{ type: "text", text: "It is a fixture." }] }],
      }
    })

    await loadCli()
    expect(mocks.uiOptions?.onImagePathPaste?.("tests/fixtures/dragged\\ image.ppm")).toBe(true)
    await vi.waitFor(() => expect(mocks.ui.setImageAttachmentCount).toHaveBeenCalledWith(1))

    await submit("describe this")

    expect(session.admitPrompt).toHaveBeenCalledWith({
      role: "user",
      content: [
        expect.objectContaining({
          type: "image",
          mimeType: "image/x-portable-pixmap",
          name: "dragged image.ppm",
        }),
        { type: "text", text: "describe this" },
      ],
    })
    expect(mocks.ui.setImageAttachmentCount).toHaveBeenLastCalledWith(0)
  })

  it("keeps admitted failed prompts in live context", async () => {
    const histories: unknown[] = []
    const session = testSession()
    mocks.createSession.mockResolvedValue(session)
    mocks.runAgent
      .mockImplementationOnce(async function* (_input, history) {
        histories.push(clone(history))
        yield { type: "error", message: "provider down" }
      })
      .mockImplementationOnce(async function* (_input, history) {
        histories.push(clone(history))
        yield { type: "error", message: "still down" }
      })

    await loadCli()
    await submit("first")
    await submit("second")

    expect(histories[1]).toEqual([{ role: "user", content: "first" }])
  })

  it("keeps completed replies in live context when saving the turn fails", async () => {
    const histories: unknown[] = []
    const firstTurn = [
      { role: "user" as const, content: "first" },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "ok" }] },
    ]
    const session = testSession({ completeTurn: vi.fn(async () => Promise.reject(new Error("disk full"))) })
    mocks.createSession.mockResolvedValue(session)
    mocks.runAgent
      .mockImplementationOnce(async function* (_input, history) {
        histories.push(clone(history))
        yield { type: "delta", text: "ok" }
        yield { type: "complete", messages: firstTurn }
      })
      .mockImplementationOnce(async function* (_input, history) {
        histories.push(clone(history))
        yield { type: "error", message: "stop" }
      })

    await loadCli()
    await submit("first")
    await submit("second")

    expect(histories[1]).toEqual(firstTurn)
  })

  it("keeps and persists interrupted work for the next prompt", async () => {
    const histories: unknown[] = []
    const interruptedTurn = [
      { role: "user" as const, content: "add the setting" },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "I added a dedicated test." }] },
    ]
    const session = testSession()
    mocks.createSession.mockResolvedValue(session)
    mocks.runAgent
      .mockImplementationOnce(async function* () {
        yield { type: "delta", text: "I added a dedicated test." }
        yield { type: "interrupted", messages: interruptedTurn }
      })
      .mockImplementationOnce(async function* (_input, history) {
        histories.push(clone(history))
        yield { type: "error", message: "stop" }
      })

    await loadCli()
    await submit("add the setting")
    await submit("remove this test")

    expect(histories[0]).toEqual(interruptedTurn)
    expect(session.interruptTurn).toHaveBeenCalledWith(
      expect.objectContaining({ promptId: "prompt_add the setting" }),
      interruptedTurn,
      [],
    )
  })

  it("persists completed tool activity and diffs with the turn", async () => {
    const session = testSession()
    const messages = [
      { role: "user" as const, content: "edit app.ts" },
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool_call" as const,
            toolCall: { id: "call_edit", name: "edit", arguments: '{"path":"app.ts","old":"a","new":"b"}' },
          },
        ],
      },
      { role: "tool" as const, toolCallId: "call_edit", content: "updated" },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "Done." }] },
    ]
    mocks.createSession.mockResolvedValue(session)
    mocks.runAgent.mockImplementationOnce(async function* () {
      yield {
        type: "tool",
        phase: "start",
        toolCallId: "call_edit",
        name: "edit",
        activityKind: "file_edit",
        label: "Editing file: app.ts",
      }
      yield {
        type: "tool",
        phase: "end",
        toolCallId: "call_edit",
        name: "edit",
        activityKind: "file_edit",
        label: "Editing file: app.ts",
        diff: "--- app.ts\n+++ app.ts\n-a\n+b",
      }
      yield { type: "complete", messages }
    })

    await loadCli()
    await submit("edit app.ts")

    expect(session.completeTurn).toHaveBeenCalledWith(
      expect.objectContaining({ promptId: "prompt_edit app.ts" }),
      messages,
      [
        {
          toolCallId: "call_edit",
          activityKind: "file_edit",
          label: "Editing file: app.ts",
          diff: "--- app.ts\n+++ app.ts\n-a\n+b",
        },
      ],
    )
  })

  it("restores tool cards, diffs, and diff totals when reopening a session", async () => {
    const messages = [
      { role: "user" as const, content: "edit app.ts" },
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool_call" as const,
            toolCall: { id: "call_edit", name: "edit", arguments: '{"path":"app.ts","old":"a","new":"b"}' },
          },
        ],
      },
      { role: "tool" as const, toolCallId: "call_edit", content: "updated" },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "Done." }] },
    ]
    const toolActivities = [
      {
        toolCallId: "call_edit",
        activityKind: "file_edit" as const,
        label: "Editing file: app.ts",
        diff: "--- app.ts\n+++ app.ts\n-old\n+new",
      },
    ]
    const session = testSession({ id: "session_saved", replay: vi.fn(() => ({ messages, toolActivities })) })
    mocks.openSession.mockResolvedValue(session)

    await loadCli()
    mocks.uiOptions?.onSelectSession?.("session_saved")
    await settle()

    const entries = mocks.ui.renderTranscript.mock.calls.at(-1)?.[0]
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "tool",
          toolCallId: "call_edit",
          text: "Editing file: app.ts",
          diff: toolActivities[0].diff,
        }),
      ]),
    )
    expect(mocks.ui.setDiffStats).toHaveBeenLastCalledWith(1, 1)
  })

  it("closes stale session history when starting a new session", async () => {
    await loadCli()

    await submit("/history")
    await submit("/new")

    expect(mocks.ui.hideSessionPicker).toHaveBeenCalled()
  })

  it("deletes a session and refreshes the picker", async () => {
    mocks.listSessions.mockResolvedValue([
      { id: "session_1", title: "First", messageCount: 2, updatedAt: "2025-01-01T00:00:00Z", mtimeMs: 0 },
    ])

    await loadCli()

    mocks.uiOptions?.onDeleteSession?.("session_1")
    await settle()

    expect(mocks.deleteSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session_1" }))
    expect(mocks.ui.showSessionPicker).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "session_1", title: "First", active: false }),
    ])
  })

  it("does not report deletion failure when only the post-delete refresh fails", async () => {
    mocks.listSessions.mockRejectedValue(new Error("session directory changed"))

    await loadCli()

    mocks.ui.showChatLayout.mockClear()
    mocks.uiOptions?.onDeleteSession?.("session_1")
    await settle()

    expect(mocks.deleteSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session_1" }))
    expect(mocks.ui.showChatLayout).not.toHaveBeenCalled()
  })

  it("re-syncs the session picker from disk after a deletion failure", async () => {
    mocks.deleteSession.mockRejectedValue(new Error("permission denied"))
    mocks.listSessions.mockResolvedValue([
      { id: "session_1", title: "First", messageCount: 2, updatedAt: "2025-01-01T00:00:00Z", mtimeMs: 0 },
    ])

    await loadCli()

    mocks.ui.showSessionPicker.mockClear()
    mocks.uiOptions?.onDeleteSession?.("session_1")
    await settle()

    expect(mocks.deleteSession).toHaveBeenCalled()
    expect(mocks.ui.showSessionPicker).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "session_1", title: "First", active: false }),
    ])
  })

  it("re-syncs the session picker when delete is skipped because a turn is busy", async () => {
    mocks.listSessions.mockResolvedValue([
      { id: "session_1", title: "First", messageCount: 2, updatedAt: "2025-01-01T00:00:00Z", mtimeMs: 0 },
    ])

    await loadCli()

    let finishTurn!: () => void
    const turnFinished = new Promise<void>((resolve) => {
      finishTurn = resolve
    })
    mocks.runAgent.mockImplementationOnce(async function* () {
      yield { type: "model", phase: "start" }
      await turnFinished
    })
    void submit("working on something")

    mocks.ui.showSessionPicker.mockClear()
    mocks.uiOptions?.onDeleteSession?.("session_1")
    await settle()

    expect(mocks.deleteSession).not.toHaveBeenCalled()
    expect(mocks.ui.showSessionPicker).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "session_1", title: "First", active: false }),
    ])

    finishTurn()
    await settle()
  })

  it("returns to the home screen with slash home", async () => {
    await loadCli()

    await submit("/home")

    expect(mocks.ui.clearInput).toHaveBeenCalled()
    expect(mocks.ui.showHomeLayout).toHaveBeenCalled()
    expect(mocks.ui.focusInput).toHaveBeenCalled()
  })

  it("generates and persists an AI title after the first completed turn", async () => {
    const session = testSession()
    mocks.createSession.mockResolvedValue(session)
    mocks.runAgent.mockImplementationOnce(async function* () {
      yield { type: "delta", text: "hello" }
      yield { type: "complete", messages: [{ role: "user", content: "fix the bug" }] }
    })
    mocks.generateCompletion.mockResolvedValue("Fix parser bug")

    await loadCli()
    await submit("fix the bug")
    await settle()

    expect(mocks.generateCompletion).toHaveBeenCalledOnce()
    expect(session.renameTitle).toHaveBeenCalledWith("Fix parser bug")
    expect(mocks.ui.setSessionLabel).toHaveBeenCalledWith("Fix parser bug")
  })

  it("does not overwrite the session label if the user switched sessions during title generation", async () => {
    const firstSession = testSession()
    const secondSession = testSession({ id: "session_other" })
    mocks.createSession.mockResolvedValue(firstSession)
    mocks.openSession.mockResolvedValue(secondSession)
    mocks.runAgent.mockImplementationOnce(async function* () {
      yield { type: "delta", text: "hello" }
      yield { type: "complete", messages: [{ role: "user", content: "fix the bug" }] }
    })

    let resolveTitle!: () => void
    mocks.generateCompletion.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveTitle = () => resolve("Fix parser bug")
      }),
    )

    await loadCli()
    await submit("fix the bug")
    await settle()

    // User switches to another session while title generation is in flight
    mocks.uiOptions?.onSelectSession?.("session_other")
    await settle()

    // Now title generation completes
    resolveTitle()
    await settle()

    expect(firstSession.renameTitle).not.toHaveBeenCalled()
    expect(mocks.ui.setSessionLabel).not.toHaveBeenCalledWith("Fix parser bug")
  })

  it("does not overwrite the session label if the user switches while the title is being saved", async () => {
    let finishRename!: () => void
    const renameFinished = new Promise<undefined>((resolve) => {
      finishRename = () => resolve(undefined)
    })
    const firstSession = testSession({ renameTitle: vi.fn(() => renameFinished) })
    const secondSession = testSession({ id: "session_other" })
    mocks.createSession.mockResolvedValue(firstSession)
    mocks.openSession.mockResolvedValue(secondSession)
    mocks.generateCompletion.mockResolvedValue("Fix parser bug")
    mocks.runAgent.mockImplementationOnce(async function* () {
      yield { type: "complete", messages: [{ role: "user", content: "fix the bug" }] }
    })

    await loadCli()
    await submit("fix the bug")
    await settle()
    expect(firstSession.renameTitle).toHaveBeenCalledWith("Fix parser bug")

    mocks.uiOptions?.onSelectSession?.("session_other")
    await settle()
    finishRename()
    await settle()

    expect(mocks.ui.setSessionLabel).not.toHaveBeenCalledWith("Fix parser bug")
  })

  it("does not generate a title when the session already has one", async () => {
    const session = testSession({ hasTitle: vi.fn(() => true) })
    mocks.createSession.mockResolvedValue(session)
    mocks.runAgent.mockImplementationOnce(async function* () {
      yield { type: "delta", text: "hello" }
      yield { type: "complete", messages: [{ role: "user", content: "fix the bug" }] }
    })

    await loadCli()
    await submit("fix the bug")
    await settle()

    expect(mocks.generateCompletion).not.toHaveBeenCalled()
    expect(session.renameTitle).not.toHaveBeenCalled()
  })

  it("does not generate a title when the turn is interrupted", async () => {
    const session = testSession()
    mocks.createSession.mockResolvedValue(session)
    mocks.runAgent.mockImplementationOnce(async function* () {
      yield { type: "delta", text: "partial" }
      // No complete event — turn is interrupted
    })

    await loadCli()
    await submit("fix the bug")
    await settle()

    expect(mocks.generateCompletion).not.toHaveBeenCalled()
    expect(session.renameTitle).not.toHaveBeenCalled()
  })

  it("updates the context indicator from agent context events", async () => {
    const session = testSession()
    mocks.createSession.mockResolvedValue(session)
    mocks.runAgent.mockImplementationOnce(async function* () {
      yield { type: "context", messageCount: 1, contentChars: 100 }
      yield { type: "delta", text: "working" }
      yield { type: "context", messageCount: 3, contentChars: 500_000 }
      yield { type: "complete", messages: [{ role: "user", content: "test" }] }
    })

    await loadCli()
    mocks.ui.setContextLabel.mockClear()
    await submit("test")

    const labels = mocks.ui.setContextLabel.mock.calls.map((call) => call[0] as string)
    expect(labels.some((label) => label.includes("~126k"))).toBe(true)
    // The meter is relative to the auto-compact threshold (80% of 131K = 104,857),
    // so ~126k tokens reads 100%, not 96% of the full context window.
    expect(labels.some((label) => label.includes("100%"))).toBe(true)
    expect(labels.some((label) => label.includes("96%"))).toBe(false)
  })

  it("shows context usage relative to the 250K auto-compact threshold on a 1M-context model", async () => {
    const session = testSession()
    mocks.createSession.mockResolvedValue(session)
    mocks.loadLocalSettings.mockResolvedValue(localSettings({ modelContextLength: 1_000_000 }))
    mocks.runAgent.mockImplementationOnce(async function* () {
      yield { type: "context", messageCount: 1, contentChars: 500_000 }
      yield { type: "delta", text: "working" }
      yield { type: "complete", messages: [{ role: "user", content: "test" }] }
    })

    await loadCli()
    mocks.ui.setContextLabel.mockClear()
    await submit("test")

    const labels = mocks.ui.setContextLabel.mock.calls.map((call) => call[0] as string)
    // ~126k of 250K threshold = 50%; relative to the full 1M window it would read 13%.
    expect(labels.some((label) => label.includes("~126k"))).toBe(true)
    expect(labels.some((label) => label.includes("50%"))).toBe(true)
    expect(labels.some((label) => label.includes("13%"))).toBe(false)
  })

  it("includes project context size in the context meter estimate", async () => {
    const session = testSession()
    mocks.createSession.mockResolvedValue(session)
    mocks.loadProjectContext.mockReturnValue([{ path: "/repo/AGENTS.md", content: "A".repeat(4_000) }])
    mocks.runAgent.mockImplementationOnce(async function* () {
      yield { type: "context", messageCount: 1, contentChars: 100 }
      yield { type: "delta", text: "done" }
      yield { type: "complete", messages: [{ role: "user", content: "test" }] }
    })

    await loadCli()
    mocks.ui.setContextLabel.mockClear()
    await submit("test")

    const labels = mocks.ui.setContextLabel.mock.calls.map((call) => call[0] as string)
    // 4000 chars of project context = 1000 extra tokens beyond the baseline.
    // Baseline with 100 contentChars: 1000 + ceil((2 + 4000 + 100) / 4) + 1*4 = 1000 + 1026 + 4 = 2030
    // Without project context it would be: 1000 + ceil((2 + 100) / 4) + 4 = 1000 + 26 + 4 = 1030
    // The label must reflect the ~2030 estimate, not ~1030.
    expect(labels.some((label) => label.includes("~2k"))).toBe(true)
    expect(labels.some((label) => label.includes("~1k"))).toBe(false)
  })

  it("passes the startup skill catalog to interactive agent turns", async () => {
    const skill = {
      name: "review",
      description: "Review code changes.",
      root: "/skills/review",
      instructionsPath: "/skills/review/SKILL.md",
    }
    mocks.loadSkillCatalog.mockResolvedValue({ skills: [skill], byName: new Map([[skill.name, skill]]) })
    mocks.runAgent.mockImplementationOnce(async function* () {
      yield { type: "delta", text: "done" }
      yield { type: "complete", messages: [{ role: "user", content: "review this" }] }
    })

    await loadCli()
    await submit("review this")

    expect(mocks.runAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ skills: expect.objectContaining({ skills: [skill] }) }),
    )
  })
})
