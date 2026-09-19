import { ArtifactPublisher } from "../artifacts/publisher.js"
import type { FileArtifactReference } from "../artifacts/types.js"
import type { JsonlSession } from "../storage/index.js"

export function sessionArtifactPublisher(session: JsonlSession) {
  const references = session
    .replayTranscript()
    .toolActivities.map((activity) => activity.artifact)
    .filter((reference): reference is FileArtifactReference => reference !== undefined)
  return new ArtifactPublisher(session.artifactDirectory, references)
}
