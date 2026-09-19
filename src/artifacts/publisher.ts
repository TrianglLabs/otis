import { randomUUID } from "node:crypto"
import { artifactDigest, savePublishedArtifact } from "./published.js"
import { type FileArtifactReference, isPublishedArtifactReference, type PublishedArtifactReference } from "./types.js"

/** One turn's publication writer, seeded from the full session rather than the model's compacted context. */
export class ArtifactPublisher {
  #latest = new Map<string, PublishedArtifactReference>()

  constructor(
    private readonly directory: string,
    references: readonly FileArtifactReference[] = [],
  ) {
    for (const reference of references) {
      if (!isPublishedArtifactReference(reference)) continue
      const previous = this.#latest.get(reference.artifactId)
      if (!previous || reference.version > previous.version) this.#latest.set(reference.artifactId, reference)
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
      previous && previous.sha256 === sha256 && previous.name === source.name && previous.sourcePath === source.path
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
    // Re-publishing unchanged content also repairs a missing or damaged copy, without inventing a new revision.
    await savePublishedArtifact(bytes, reference, this.directory)
    this.#latest.set(reference.artifactId, reference)
    return reference
  }
}
