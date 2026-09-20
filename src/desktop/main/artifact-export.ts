import { randomUUID } from "node:crypto"
import { rename, rm, writeFile } from "node:fs/promises"
import { dirname, extname, join } from "node:path"
import type { ArtifactFile } from "../../artifacts/types.js"
import type { SessionOpResult } from "../contracts.js"

/** Save the captured revision only to a destination chosen through the native Save dialog. */
export async function saveArtifactCopy(
  file: ArtifactFile,
  choosePath: (name: string) => Promise<string | undefined>,
): Promise<SessionOpResult> {
  try {
    const path = await choosePath(file.name)
    if (!path) return { ok: true }
    if (extname(path).toLowerCase() !== extname(file.name).toLowerCase())
      throw new Error(`Keep the ${extname(file.name)} extension. Saving a copy does not convert the file.`)
    const temporary = join(dirname(path), `.otis-export-${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, file.bytes, { flag: "wx", mode: 0o600 })
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true })
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
