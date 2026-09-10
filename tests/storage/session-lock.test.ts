import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { acquireSessionLock } from "../../src/storage/index.js"

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("session locks", () => {
  it("excludes a concurrent owner and can be reacquired after release", async () => {
    const directory = await mkdtemp(join(tmpdir(), "otis-lock-"))
    tempDirectories.push(directory)
    const options = { cwd: directory, directory: join(directory, "sessions"), sessionId: "shared" }
    const first = await acquireSessionLock(options)

    await expect(acquireSessionLock(options)).rejects.toThrow("already in use")
    await first.release()
    const second = await acquireSessionLock(options)

    await second.release()
  })
})

describe("same-process contention", () => {
  it("grants exactly one owner when 100 acquisitions race", async () => {
    const home = await mkdtemp(join(tmpdir(), "otis-lock-"))
    tempDirectories.push(home)
    const results = await Promise.allSettled(
      Array.from({ length: 100 }, () => acquireSessionLock({ cwd: home, sessionId: "contended" })),
    )
    const granted = results.filter((r) => r.status === "fulfilled")
    expect(granted).toHaveLength(1)
    for (const r of granted) if (r.status === "fulfilled") await r.value.release()
  })
})
