import { readSkillResource } from "../skills/index.js"
import { runDocumentWorkflow } from "./document-workflow.js"
import { editLocalDocument } from "./documents.js"
import { editLocalFile, readLocalFile, writeLocalFile } from "./files.js"
import { globLocalFiles, grepLocalFiles } from "./search.js"
import { runBash } from "./shell.js"
import type { ToolCall, ToolContext, ToolResult } from "./types.js"

export {
  describeToolCall,
  isToolActivityKind,
  TOOL_ACTIVITY_KINDS,
  type ToolActivity,
  type ToolActivityKind,
} from "./activity.js"
export {
  parseSerializedToolCall,
  parseStructuredToolCall,
  TOOL_DEFINITIONS,
  type ToolDefinition,
} from "./schema.js"

import { TOOL_DEFINITIONS, type ToolDefinition } from "./schema.js"

export {
  TOOL_NAMES,
  type ToolCall,
  type ToolContext,
  type ToolName,
  type ToolResult,
} from "./types.js"

import { createHash, randomUUID } from "node:crypto"
import { link, rm, writeFile } from "node:fs/promises"
import { basename, dirname, extname, join } from "node:path"
import {
  readArtifactBytes,
  resolveArtifactSource,
  workspaceArtifactReference,
} from "../artifacts/files.js"
import { artifactKindForPath } from "../artifacts/types.js"
import { MAX_RAW_DOCUMENT_BYTES } from "../inference/document-constraints.js"
import type { ModelProvider } from "../inference/types.js"
import { resolveWorkspacePath } from "./workspace.js"

export async function executeToolCall(
  call: ToolCall,
  context: ToolContext = {},
): Promise<ToolResult> {
  switch (call.name) {
    case "agent":
      throw new Error("The agent tool runs inside the agent loop, not as a standalone tool.")
    case "web_search":
    case "web_read":
      return executeWebTool(call, context)
    case "skill":
      if (!context.skills) throw new Error("No skills are available.")
      return readSkillResource(context.skills, call.input.skill, call.input.path)
    case "read":
      return readLocalFile(call.input.path, call.input.offset, call.input.limit, context)
    case "grep":
      return grepLocalFiles(
        call.input.pattern,
        call.input.path,
        call.input.include,
        call.input.maxResults,
        context,
      )
    case "glob":
      return globLocalFiles(call.input.pattern, call.input.path, call.input.maxResults, context)
    case "write":
      return writeLocalFile(call.input.path, call.input.content, context)
    case "edit":
      return editLocalFile(call.input.path, call.input.old, call.input.new, context)
    case "edit_document":
      return editLocalDocument(call.input, context)
    case "document":
      return runDocumentWorkflow(call.input, context)
    case "save_attachment":
      return saveAttachment(call.input, context)
    case "bash":
      return runBash(call.input.command, call.input.timeoutMs, context)
    case "publish_artifact":
      return publishArtifact(call.input.path, call.input.artifactId, context)
  }
}

async function executeWebTool(
  call: Extract<ToolCall, { name: "web_search" | "web_read" }>,
  context: ToolContext,
): Promise<ToolResult> {
  if (!context.webClient) throw new Error("Web client is not configured.")
  const request = {
    clientModel: context.webClientModel,
    sessionId: context.webSession?.id,
    signal: context.signal,
  }
  if (call.name === "web_search") {
    const response = await context.webClient.search({ ...call.input, ...request })
    if (context.webSession) context.webSession.id = response.sessionId
    const sections = response.results.map((result, index) =>
      [
        `${index + 1}. ${result.title ?? result.url}`,
        [result.url, result.publishDate].filter(Boolean).join(" · "),
        ...result.excerpts,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    if (sections.length === 0) sections.push("No search results found.")
    return { title: call.input.objective, output: withWarnings(sections, response.warnings) }
  }
  const response = await context.webClient.read({ ...call.input, ...request })
  if (context.webSession) context.webSession.id = response.sessionId
  const sections = response.results.map((result) =>
    [
      `# ${result.title ?? result.url}`,
      result.url,
      (result.fullContent ?? result.excerpts.join("\n")) || "No extractable content found.",
    ].join("\n\n"),
  )
  for (const error of response.errors) {
    const status = error.status ? ` (HTTP ${error.status})` : ""
    sections.push(
      `Could not read ${error.url}: ${error.type}${status}${error.content ? `\n${error.content}` : ""}`,
    )
  }
  if (sections.length === 0) sections.push("No extractable content found.")
  return { title: call.input.url, output: withWarnings(sections, response.warnings) }
}

function withWarnings(sections: string[], warnings: string[]) {
  if (warnings.length > 0)
    sections.push(`Warnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`)
  return sections.join("\n\n")
}

/**
 * The tool catalog a top-level turn exposes for the selected model's provider. Delegation issues
 * several long model runs at once. Otis' managed llama-server serves a single slot, so only hosted
 * Fireworks models, NVIDIA PAIR clusters, and oMLX's batched server offer the agent tool.
 */
export function providerTools(provider: ModelProvider): ToolDefinition[] {
  return TOOL_DEFINITIONS.filter((tool) => tool.name !== "agent" || provider !== "local")
}

async function publishArtifact(
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
    throw new Error(
      "Publishing a file outside the workspace requires approval for that exact file.",
    )
  }
  const name = basename(path)
  const kind = artifactKindForPath(name)
  if (!kind) throw new Error("Publish supports Markdown, text, HTML, PDF, and DOCX files.")
  context.signal?.throwIfAborted()
  const bytes = await readArtifactBytes(source.path)
  context.signal?.throwIfAborted()
  const artifact = await context.artifactPublisher.publish(
    bytes,
    { name, kind, path: source.path },
    artifactId,
  )
  return {
    title: `Published: ${name}`,
    output: `Published ${name}, version ${artifact.version}. artifact_id: ${artifact.artifactId}\nSource: ${source.path}\nThe original file is unchanged. Pass this artifact_id when publishing revisions of this deliverable, including after moving or renaming it.`,
    artifact,
  }
}

async function saveAttachment(
  input: Extract<ToolCall, { name: "save_attachment" }>["input"],
  context: ToolContext,
): Promise<ToolResult> {
  context.signal?.throwIfAborted()
  const extension = extname(input.path).toLowerCase()
  const candidates = (context.attachments?.() ?? []).filter(
    (part) =>
      part.name === input.attachment ||
      (part.type === "document" && part.sha256 === input.attachment),
  )
  const unique = [...new Map(candidates.map((part) => [part.data, part])).values()]
  if (unique.length === 0)
    throw new Error("Attachment not found in this session. Use its exact name or SHA-256.")
  if (unique.length > 1)
    throw new Error("Attachment name is ambiguous. Select the document by SHA-256 instead.")
  const attachment =
    candidates.find((part) => extname(part.name).toLowerCase() === extension) ?? unique[0]
  if (extension !== extname(attachment.name).toLowerCase()) {
    throw new Error("Saving an attachment does not convert it. Keep its original file extension.")
  }
  if (
    attachment.sizeBytes > MAX_RAW_DOCUMENT_BYTES ||
    attachment.data.length > Math.ceil(MAX_RAW_DOCUMENT_BYTES / 3) * 4
  ) {
    throw new Error("Attachment exceeds the file size limit.")
  }
  const bytes = Buffer.from(attachment.data, "base64")
  if (bytes.length !== attachment.sizeBytes || bytes.length === 0)
    throw new Error("Attachment size does not match its source.")
  if (
    attachment.type === "document" &&
    createHash("sha256").update(bytes).digest("hex") !== attachment.sha256
  ) {
    throw new Error("Attachment content does not match its SHA-256.")
  }
  const target = await resolveWorkspacePath(input.path, context, { allowMissingLeaf: true })
  const artifact = await workspaceArtifactReference(target, context.cwd ?? process.cwd())
  const temporary = join(dirname(target), `.otis-attachment-${randomUUID()}`)
  try {
    await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" })
    context.signal?.throwIfAborted()
    // Linking a complete sibling file publishes atomically and refuses any existing destination.
    await link(temporary, target)
  } finally {
    await rm(temporary, { force: true })
  }
  return {
    title: `Save attachment: ${target}`,
    output: `Saved the original ${attachment.sizeBytes} bytes to ${input.path}. The uploaded source is unchanged.`,
    ...(artifact ? { artifact } : {}),
  }
}
