import { createHash, randomUUID } from "node:crypto"
import { chmod, mkdir, open, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import { readArtifactBytes } from "./bytes.js"
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
  const bytes = await readPublishedArtifactBytes(reference, directory)
  return payloadFromBytes(bytes, publishedArtifactMetadata(reference, revision), reference.name)
}

export async function readPublishedArtifactBytes(reference: PublishedArtifactReference, directory: string) {
  if (!isPublishedArtifactReference(reference)) throw new Error("Invalid published artifact reference.")
  const bytes = await readArtifactBytes(join(directory, reference.sha256)).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      throw new Error("This published copy is no longer available. Ask Otis to publish the source file again.")
    }
    throw error
  })
  if (artifactDigest(bytes) !== reference.sha256)
    throw new Error("This published copy is damaged. Publish the source file again.")
  return bytes
}

export function artifactDigest(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex")
}
