import { appendFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { listGlobalHistory, listGlobalSessionPickerItems } from "../../src/app/global-sessions.js"
import { sessionRootDirectory } from "../../src/storage/session-files.js"
import { useOtisHome } from "./support/otis-home.js"

const isolate = useOtisHome()

async function sessionWithText(dirName: string, sessionId: string, text: string) {
  const dir = join(sessionRootDirectory(), dirName)
  await mkdir(dir, { recursive: true })
  const line = (event: Record<string, unknown>) => `${JSON.stringify(event)}\n`
  await appendFile(
    join(dir, `${sessionId}.jsonl`),
    line({ seq: 1, sessionId, at: new Date().toISOString(), type: "session_started", version: 1 }) +
      line({
        seq: 2,
        sessionId,
        at: new Date().toISOString(),
        type: "prompt_admitted",
        promptId: "p1",
        message: { role: "user", content: text },
      }),
    { mode: 0o600 },
  )
}

describe("global picker items", () => {
  it("marks active by full (dir, id) identity — duplicate ids never both light up", async () => {
    await isolate()
    await sessionWithText("alpha-aaaaaaaaaaaa", "default", "alpha default")
    await sessionWithText("beta-bbbbbbbbbbbb", "default", "beta default")

    const open = (dirName: string) => [
      { id: "default", dirName, focused: true, working: false, unseen: false },
    ]
    const items = await listGlobalSessionPickerItems({ open: open("beta-bbbbbbbbbbbb") })
    expect(items).toHaveLength(2)
    const active = items.filter((item) => item.active)
    expect(active).toHaveLength(1)
    expect(active[0].dirName).toBe("beta-bbbbbbbbbbbb")

    const none = await listGlobalSessionPickerItems({ open: open("elsewhere-cccccccccccc") })
    expect(none.every((item) => !item.active)).toBe(true)
  })
})

const SHA = "a".repeat(64)
const published = (artifactId: string, version: number, kind: string, name: string) => ({
  source: "published",
  artifactId,
  version,
  sha256: SHA,
  name,
  kind,
  sourcePath: `/tmp/${name}`,
})

/** A session whose turns each publish one artifact; `at` timestamps the turn's completion. */
async function sessionPublishing(
  dirName: string,
  sessionId: string,
  turns: { at: string; artifact: ReturnType<typeof published> }[],
) {
  const dir = join(sessionRootDirectory(), dirName)
  await mkdir(dir, { recursive: true })
  const events: Record<string, unknown>[] = [{ type: "session_started", version: 1 }]
  turns.forEach(({ at, artifact }, index) => {
    const promptId = `p${index + 1}`
    const callId = `call_${index + 1}`
    events.push(
      { at, type: "prompt_admitted", promptId, message: { role: "user", content: "publish" } },
      { at, type: "turn_started", promptId },
      {
        at,
        type: "turn_completed",
        promptId,
        messages: [
          {
            role: "assistant",
            content: [
              { type: "tool_call", toolCall: { id: callId, name: "file_write", arguments: "{}" } },
            ],
          },
          { role: "tool", toolCallId: callId, content: "Published" },
        ],
        toolActivities: [
          { toolCallId: callId, activityKind: "file_write", label: artifact.name, artifact },
        ],
      },
    )
  })
  await appendFile(
    join(dir, `${sessionId}.jsonl`),
    events
      .map((event, index) =>
        JSON.stringify({
          seq: index + 1,
          sessionId,
          at: "2026-01-01T00:00:00.000Z",
          ...event,
        }),
      )
      .join("\n")
      .concat("\n"),
    { mode: 0o600 },
  )
}

describe("global history", () => {
  it("lists sessions and the newest version of each Canvas document together", async () => {
    await isolate("otis-history-")
    const doc = "11111111-1111-4111-8111-111111111111"
    const note = "22222222-2222-4222-8222-222222222222"
    const page = "33333333-3333-4333-8333-333333333333"
    await sessionPublishing("alpha-000000000001", "s1", [
      { at: "2026-03-01T10:00:00.000Z", artifact: published(doc, 1, "markdown", "plan.md") },
      { at: "2026-03-01T12:00:00.000Z", artifact: published(doc, 2, "markdown", "plan.md") },
      { at: "2026-03-01T13:00:00.000Z", artifact: published(note, 1, "text", "notes.txt") },
    ])
    await sessionPublishing("beta-000000000002", "s2", [
      { at: "2026-03-02T09:00:00.000Z", artifact: published(page, 1, "html", "site.html") },
    ])

    const history = await listGlobalHistory(5, {})
    expect(history.sessions.map((session) => session.id).sort()).toEqual(["s1", "s2"])
    // One row per artifact at its latest version; plain text never reaches Canvas; newest first.
    expect(
      history.artifacts.map(({ name, reference, sessionId, updatedAt }) => ({
        name,
        version: reference.version,
        sessionId,
        updatedAt,
      })),
    ).toEqual([
      { name: "site.html", version: 1, sessionId: "s2", updatedAt: "2026-03-02T09:00:00.000Z" },
      { name: "plan.md", version: 2, sessionId: "s1", updatedAt: "2026-03-01T12:00:00.000Z" },
    ])
    expect(history.artifacts[1]?.workspaceLabel).toBe("alpha")
    expect((await listGlobalHistory(1, {})).artifacts.map((row) => row.name)).toEqual(["site.html"])
  })
})
