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
