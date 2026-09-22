import { readFile, stat } from "node:fs/promises"
import { basename, extname, resolve } from "node:path"
import {
  MAX_DOCUMENTS_PER_MESSAGE,
  MAX_RAW_DOCUMENT_BYTES,
  SUPPORTED_DOCUMENT_EXTENSIONS,
} from "./document-constraints.js"
import { createDocumentAttachment, validateDocumentAttachments } from "./documents.js"
import {
  createImageAttachment,
  detectImageMimeType,
  parsePastedFilePaths,
  validateImageAttachments,
} from "./images.js"
import {
  type AttachmentContentPart,
  type DocumentContentPart,
  type ImageContentPart,
  MAX_IMAGES_PER_REQUEST,
  SUPPORTED_IMAGE_EXTENSIONS,
} from "./types.js"

const ATTACHMENT_FILE_EXTENSIONS = new Set<string>([
  ...SUPPORTED_IMAGE_EXTENSIONS,
  ...SUPPORTED_DOCUMENT_EXTENSIONS,
])

export async function createAttachment(
  bytes: Uint8Array,
  name: string,
  declaredMimeType?: string,
): Promise<AttachmentContentPart> {
  const imageClaimed =
    declaredMimeType?.toLowerCase().startsWith("image/") ||
    (SUPPORTED_IMAGE_EXTENSIONS as readonly string[]).includes(extname(name).toLowerCase())
  return detectImageMimeType(bytes) || imageClaimed
    ? createImageAttachment(bytes, name, declaredMimeType)
    : createDocumentAttachment(bytes, name, declaredMimeType)
}

export async function loadAttachmentFiles(
  paths: readonly string[],
  cwd: string,
): Promise<AttachmentContentPart[]> {
  const maxFiles = MAX_IMAGES_PER_REQUEST + MAX_DOCUMENTS_PER_MESSAGE
  if (paths.length > maxFiles) throw new Error(`Attach at most ${maxFiles} files to one message.`)
  const attachments: AttachmentContentPart[] = []
  for (const path of paths) {
    const absolutePath = resolve(cwd, path)
    const file = await stat(absolutePath)
    if (!file.isFile()) throw new Error(`Attachment path is not a file: ${path}`)
    if (file.size === 0) throw new Error(`Attachment file is empty: ${path}`)
    if (file.size > MAX_RAW_DOCUMENT_BYTES) {
      throw new Error(
        `Attachment exceeds the ${MAX_RAW_DOCUMENT_BYTES / (1024 * 1024)} MB file limit: ${path}`,
      )
    }
    attachments.push(await createAttachment(await readFile(absolutePath), basename(absolutePath)))
    validateAttachments(attachments)
  }
  return attachments
}

export function validateAttachments(attachments: readonly AttachmentContentPart[]) {
  validateImageAttachments(
    attachments.filter((attachment): attachment is ImageContentPart => attachment.type === "image"),
  )
  validateDocumentAttachments(
    attachments.filter(
      (attachment): attachment is DocumentContentPart => attachment.type === "document",
    ),
  )
}

export function parsePastedAttachmentPaths(value: string): string[] | undefined {
  return parsePastedFilePaths(value, ATTACHMENT_FILE_EXTENSIONS)
}
