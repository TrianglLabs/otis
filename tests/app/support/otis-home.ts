import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach } from "vitest"

// Both Otis' data root and the XDG state root move into the temporary home, so a test that runs a
// turn cannot touch the machine's real Omarchy usage record.
export function useOtisHome() {
  const directories: string[] = []
  const original = { OTIS_HOME: process.env.OTIS_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME }

  afterEach(async () => {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    )
  })

  return async (prefix = "otis-home-") => {
    const root = await mkdtemp(join(tmpdir(), prefix))
    directories.push(root)
    process.env.OTIS_HOME = root
    process.env.XDG_STATE_HOME = root
    return root
  }
}
