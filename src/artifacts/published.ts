import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { chmod, mkdir, open, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import { MAX_RAW_DOCUMENT_BYTES } from "../inference/documents.js"
import { payloadFromBytes } from "./files.js"
import {
  type ArtifactMetadata,
  artifactMimeType,
  isPublishedArtifactReference,
  type PublishedArtifactReference,
} from "./types.js"

export function publishedArtifactMetadata(reference: PublishedArtifactReference, revision: number): ArtifactMetadata {
  return {
    id: `published:${reference.artifactId}`,
    revision,
    source: "published",
    title: reference.name,
    kind: reference.kind,
    mimeType: artifactMimeType(reference.kind),
    editable: false,
    path: reference.sourcePath,
  }
}

/** Bound reads even if the source grows, and refuse directories, devices, and final-component symlinks. */
export async function readArtifactBytes(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const file = await handle.stat()
    if (!file.isFile()) throw new Error("Only regular files can be published as artifacts.")
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
      throw new Error("The file changed while being published. Try again once writing has finished.")
    }
    return bytes.subarray(0, length)
  } finally {
    await handle.close()
  }
}

export async function savePublishedArtifact(
  bytes: Buffer,
  reference: PublishedArtifactReference,
  directory: string,
): Promise<PublishedArtifactReference> {
  if (!isPublishedArtifactReference(reference)) throw new Error("Invalid published artifact reference.")
  if (artifactDigest(bytes) !== reference.sha256) throw new Error("Published content does not match its reference.")
  // Validate the exact bytes before persisting or advertising a successful publication.
  await payloadFromBytes(bytes, publishedArtifactMetadata(reference, 0), reference.name)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== "win32") await chmod(directory, 0o700)
  const temporary = join(directory, `${randomUUID()}.tmp`)
  try {
    const handle = await open(temporary, "wx", 0o600)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, join(directory, reference.sha256))
  } finally {
    await rm(temporary, { force: true })
  }
  return reference
}

export async function loadPublishedArtifact(
  reference: PublishedArtifactReference,
  revision: number,
  directory: string,
) {
  if (!isPublishedArtifactReference(reference)) throw new Error("Invalid published artifact reference.")
  const bytes = await readArtifactBytes(join(directory, reference.sha256)).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      throw new Error("This published copy is no longer available. Ask Otis to publish the source file again.")
    }
    throw error
  })
  if (artifactDigest(bytes) !== reference.sha256)
    throw new Error("This published copy is damaged. Publish the source file again.")
  return payloadFromBytes(bytes, publishedArtifactMetadata(reference, revision), reference.name)
}

export function artifactDigest(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex")
}
