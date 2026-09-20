import { basename } from "node:path"
import { readArtifactBytes } from "../artifacts/bytes.js"
import { resolveArtifactSource } from "../artifacts/source.js"
import { artifactKindForPath } from "../artifacts/types.js"
import type { ToolContext, ToolResult } from "./types.js"

export async function publishArtifact(
  path: string,
  artifactId: string | undefined,
  context: ToolContext,
): Promise<ToolResult> {
  if (!context.artifactPublisher) throw new Error("Publishing artifacts requires a saved session.")
  const source = await resolveArtifactSource(path, context.cwd ?? process.cwd())
  if (context.authorizedArtifactPath && context.authorizedArtifactPath !== source.path) {
    throw new Error(
      "The artifact path changed after permission was checked. Publish it again to request fresh approval.",
    )
  }
  if (source.external && context.authorizedArtifactPath !== source.path) {
    throw new Error("Publishing a file outside the workspace requires approval for that exact file.")
  }
  const name = basename(path)
  const kind = artifactKindForPath(name)
  if (!kind) throw new Error("Publish supports Markdown, text, HTML, PDF, and DOCX files.")
  context.signal?.throwIfAborted()
  const bytes = await readArtifactBytes(source.path)
  context.signal?.throwIfAborted()
  const artifact = await context.artifactPublisher.publish(bytes, { name, kind, path: source.path }, artifactId)
  return {
    title: `Published: ${name}`,
    output: `Published ${name}, version ${artifact.version}. artifact_id: ${artifact.artifactId}\nSource: ${source.path}\nThe original file is unchanged. Pass this artifact_id when publishing revisions of this deliverable, including after moving or renaming it.`,
    artifact,
  }
}
