import { appendFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { listGlobalSessionPickerItems } from "../../src/app/global-sessions.js"
import { sessionRootDirectory } from "../../src/storage/index.js"
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

    const items = await listGlobalSessionPickerItems({ activeId: "default", activeDirName: "beta-bbbbbbbbbbbb" })
    expect(items).toHaveLength(2)
    const active = items.filter((item) => item.active)
    expect(active).toHaveLength(1)
    expect(active[0].dirName).toBe("beta-bbbbbbbbbbbb")

    const none = await listGlobalSessionPickerItems({ activeId: "default", activeDirName: "elsewhere-cccccccccccc" })
    expect(none.every((item) => !item.active)).toBe(true)
  })
})
