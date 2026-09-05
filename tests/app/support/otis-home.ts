import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach } from "vitest"

export function useOtisHome() {
  const directories: string[] = []
  const original = process.env.OTIS_HOME

  afterEach(async () => {
    if (original === undefined) delete process.env.OTIS_HOME
    else process.env.OTIS_HOME = original
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  return async (prefix = "otis-home-") => {
    const root = await mkdtemp(join(tmpdir(), prefix))
    directories.push(root)
    process.env.OTIS_HOME = root
    return root
  }
}
