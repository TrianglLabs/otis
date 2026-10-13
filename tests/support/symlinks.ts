import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Whether this process may create symbolic links: always on POSIX, on Windows only with Developer
 * Mode or administrator rights (CI runners have them). The escape tests that need one skip
 * elsewhere.
 */
export const symlinksSupported = (() => {
  const directory = mkdtempSync(join(tmpdir(), "otis-symlink-probe-"))
  try {
    writeFileSync(join(directory, "target"), "")
    symlinkSync(join(directory, "target"), join(directory, "link"))
    return true
  } catch {
    return false
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})()
