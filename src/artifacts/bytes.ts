import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { MAX_RAW_DOCUMENT_BYTES } from "../inference/document-constraints.js"

/** Bound reads even if the source grows, and refuse directories, devices, and final-component symlinks. */
export async function readArtifactBytes(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const file = await handle.stat()
    if (!file.isFile()) throw new Error("Only regular files can be read as artifacts.")
    if (file.size > MAX_RAW_DOCUMENT_BYTES) throw new Error("This file is too large to preview in Canvas.")
    const bytes = Buffer.alloc(file.size + 1)
    let length = 0
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null)
      if (bytesRead === 0) break
      length += bytesRead
    }
    const after = await handle.stat()
    if (length !== file.size || after.size !== file.size || after.mtimeMs !== file.mtimeMs) {
      throw new Error("The file changed while being read. Try again once writing has finished.")
    }
    return bytes.subarray(0, length)
  } finally {
    await handle.close()
  }
}
