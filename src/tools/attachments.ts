import { createHash, randomUUID } from "node:crypto"
import { link, rm, writeFile } from "node:fs/promises"
import { dirname, extname, join } from "node:path"
import { workspaceArtifactReference } from "../artifacts/files.js"
import { MAX_RAW_DOCUMENT_BYTES } from "../inference/document-constraints.js"
import type { ToolCall, ToolContext, ToolResult } from "./types.js"
import { resolveWorkspacePath } from "./workspace.js"

export async function saveAttachment(
  input: Extract<ToolCall, { name: "save_attachment" }>["input"],
  context: ToolContext,
): Promise<ToolResult> {
  context.signal?.throwIfAborted()
  const candidates = (context.attachments?.() ?? []).filter(
    (part) => part.name === input.attachment || (part.type === "document" && part.sha256 === input.attachment),
  )
  const unique = [...new Map(candidates.map((part) => [part.data, part])).values()]
  if (unique.length === 0) throw new Error("Attachment not found in this session. Use its exact name or SHA-256.")
  if (unique.length > 1) throw new Error("Attachment name is ambiguous. Select the document by SHA-256 instead.")
  const attachment =
    candidates.find((part) => extname(part.name).toLowerCase() === extname(input.path).toLowerCase()) ?? unique[0]
  if (extname(input.path).toLowerCase() !== extname(attachment.name).toLowerCase()) {
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
  if (attachment.type === "document" && createHash("sha256").update(bytes).digest("hex") !== attachment.sha256) {
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
