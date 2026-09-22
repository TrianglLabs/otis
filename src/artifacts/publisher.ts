import { createHash, randomUUID } from "node:crypto"
import { chmod, mkdir, open, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import { payloadFromBytes, readArtifactBytes } from "./files.js"
import {
  type ArtifactMetadata,
  artifactMimeType,
  type FileArtifactReference,
  isPublishedArtifactReference,
  type PublishedArtifactReference,
} from "./types.js"

/**
 * One turn's publication writer, seeded from the full session rather than the model's compacted
 * context.
 */
export class ArtifactPublisher {
  #latest = new Map<string, PublishedArtifactReference>()

  constructor(
    private readonly directory: string,
    references: readonly FileArtifactReference[] = [],
  ) {
    for (const reference of references) {
      if (!isPublishedArtifactReference(reference)) continue
      const previous = this.#latest.get(reference.artifactId)
      if (!previous || reference.version > previous.version)
        this.#latest.set(reference.artifactId, reference)
    }
  }

  async publish(
    bytes: Buffer,
    source: { name: string; kind: PublishedArtifactReference["kind"]; path: string },
    artifactId?: string,
  ) {
    const previous = artifactId ? this.#latest.get(artifactId) : undefined
    if (artifactId && !previous)
      throw new Error("Unknown artifact_id in this session. Omit it to publish a new artifact.")
    if (previous && previous.kind !== source.kind)
      throw new Error("A different file type must be published as a new artifact.")
    const sha256 = artifactDigest(bytes)
    const unchanged =
      previous &&
      previous.sha256 === sha256 &&
      previous.name === source.name &&
      previous.sourcePath === source.path
    const reference: PublishedArtifactReference = unchanged
      ? previous
      : {
          source: "published",
          artifactId: previous?.artifactId ?? randomUUID(),
          version: (previous?.version ?? 0) + 1,
          sha256,
          name: source.name,
          kind: source.kind,
          sourcePath: source.path,
        }
    if (!isPublishedArtifactReference(reference))
      throw new Error("Invalid published artifact reference.")
    // Validate the exact bytes before persisting or advertising a successful publication.
    await payloadFromBytes(bytes, publishedArtifactMetadata(reference, 0), reference.name)
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    if (process.platform !== "win32") await chmod(this.directory, 0o700)
    // Re-publishing unchanged content also repairs a missing or damaged copy, without inventing
    // a new revision.
    const temporary = join(this.directory, `${randomUUID()}.tmp`)
    try {
      const handle = await open(temporary, "wx", 0o600)
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, join(this.directory, sha256))
    } finally {
      await rm(temporary, { force: true })
    }
    this.#latest.set(reference.artifactId, reference)
    return reference
  }
}

export function publishedArtifactMetadata(
  reference: PublishedArtifactReference,
  revision: number,
): ArtifactMetadata {
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

export async function loadPublishedArtifact(
  reference: PublishedArtifactReference,
  revision: number,
  directory: string,
) {
  const bytes = await readPublishedArtifactBytes(reference, directory)
  return payloadFromBytes(bytes, publishedArtifactMetadata(reference, revision), reference.name)
}

export async function readPublishedArtifactBytes(
  reference: PublishedArtifactReference,
  directory: string,
) {
  if (!isPublishedArtifactReference(reference))
    throw new Error("Invalid published artifact reference.")
  const bytes = await readArtifactBytes(join(directory, reference.sha256)).catch((error) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(
        "This published copy is no longer available. Ask Otis to publish the source file again.",
      )
    }
    throw error
  })
  if (artifactDigest(bytes) !== reference.sha256)
    throw new Error("This published copy is damaged. Publish the source file again.")
  return bytes
}

function artifactDigest(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex")
}
