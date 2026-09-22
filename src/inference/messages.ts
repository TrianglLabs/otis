import type {
  AssistantContentPart,
  AttachmentContentPart,
  ChatMessage,
  DocumentContentPart,
  ImageContentPart,
  UserChatMessage,
  UserContentPart,
} from "./types.js"

const ESTIMATED_IMAGE_TOKENS = 1_024
const CHARS_PER_TOKEN = 4

export function createUserMessage(
  text: string,
  attachments: readonly AttachmentContentPart[] = [],
): UserChatMessage {
  if (attachments.length === 0) return { role: "user", content: text }
  return {
    role: "user",
    content: [...attachments, ...(text ? [{ type: "text" as const, text }] : [])],
  }
}

export function textContent(parts: readonly (UserContentPart | AssistantContentPart)[]) {
  return parts.map((part) => (part.type === "text" ? part.text : "")).join("")
}

export function userMessageText(message: UserChatMessage): string {
  return typeof message.content === "string" ? message.content : textContent(message.content)
}

/** Text of the most recent assistant message, which is the final answer of a completed turn. */
export function lastAssistantText(messages: readonly ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === "assistant") return textContent(message.content).trim()
  }
  return ""
}

export function userMessageImages(message: UserChatMessage): ImageContentPart[] {
  return typeof message.content === "string"
    ? []
    : message.content.filter((part) => part.type === "image")
}

export function userMessageDocuments(message: UserChatMessage): DocumentContentPart[] {
  return typeof message.content === "string"
    ? []
    : message.content.filter((part) => part.type === "document")
}

export function userMessageAttachments(message: UserChatMessage): AttachmentContentPart[] {
  return typeof message.content === "string"
    ? []
    : message.content.filter((part) => part.type !== "text")
}

export function messagesContainImages(messages: readonly ChatMessage[]): boolean {
  return messages.some(
    (message) => message.role === "user" && userMessageImages(message).length > 0,
  )
}

export function imageAttachmentsFromMessages(messages: readonly ChatMessage[]): ImageContentPart[] {
  return messages.flatMap((message) => (message.role === "user" ? userMessageImages(message) : []))
}

export function displayUserMessage(message: UserChatMessage): string {
  const attachments = userMessageAttachments(message).map((attachment) =>
    attachment.type === "image" ? `📎 ${attachment.name}` : `📄 ${attachment.name}`,
  )
  return [userMessageText(message), ...attachments].filter(Boolean).join("\n")
}

export function userMessageContentChars(message: UserChatMessage): number {
  return (
    userMessageText(message).length +
    userMessageImages(message).length * ESTIMATED_IMAGE_TOKENS * CHARS_PER_TOKEN +
    userMessageDocuments(message).reduce(
      (total, document) => total + formatDocumentForModel(document).length,
      0,
    )
  )
}

/**
 * Produces model-readable content without copying base64 attachment data into generated
 * prompts.
 */
export function summarizeUserMessage(message: UserChatMessage): string {
  const attachments = userMessageAttachments(message).map((attachment) =>
    attachment.type === "image"
      ? `[Image: ${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)]`
      : formatDocumentForModel(attachment),
  )
  return [userMessageText(message), ...attachments].filter(Boolean).join("\n")
}

export function formatDocumentForModel(document: DocumentContentPart) {
  // sha256 lets save_attachment distinguish sources with the same filename without exposing bytes.
  const metadata = JSON.stringify({
    name: document.name,
    sha256: document.sha256,
    mimeType: document.mimeType,
    sizeBytes: document.sizeBytes,
    ...(document.pageCount === undefined ? {} : { pages: document.pageCount }),
    truncated: document.truncated,
  })
  const truncation = document.truncated
    ? "\n[Extraction was truncated at Otis's document text limit.]"
    : ""
  return `[Attached document ${metadata}]\n--- BEGIN EXTRACTED DOCUMENT TEXT ---\n${document.extractedText}${truncation}\n--- END EXTRACTED DOCUMENT TEXT ---`
}
