import type {
  AttachmentContentPart,
  ChatMessage,
  DocumentContentPart,
  ImageContentPart,
  UserChatMessage,
} from "./types.js"

export const ESTIMATED_IMAGE_TOKENS = 1_024
const CHARS_PER_TOKEN = 4

export function createUserMessage(text: string, attachments: readonly AttachmentContentPart[] = []): UserChatMessage {
  if (attachments.length === 0) return { role: "user", content: text }
  return {
    role: "user",
    content: [...attachments, ...(text ? [{ type: "text" as const, text }] : [])],
  }
}

export function userMessageText(message: UserChatMessage): string {
  if (typeof message.content === "string") return message.content
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
}

/** Text of the most recent assistant message, which is the final answer of a completed turn. */
export function lastAssistantText(messages: readonly ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== "assistant") continue
    return message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("")
      .trim()
  }
  return ""
}

export function userMessageImages(message: UserChatMessage): ImageContentPart[] {
  return typeof message.content === "string" ? [] : message.content.filter((part) => part.type === "image")
}

export function userMessageDocuments(message: UserChatMessage): DocumentContentPart[] {
  return typeof message.content === "string" ? [] : message.content.filter((part) => part.type === "document")
}

export function userMessageAttachments(message: UserChatMessage): AttachmentContentPart[] {
  return typeof message.content === "string" ? [] : message.content.filter((part) => part.type !== "text")
}

export function messagesContainImages(messages: readonly ChatMessage[]): boolean {
  return messages.some((message) => message.role === "user" && userMessageImages(message).length > 0)
}

export function imageAttachmentsFromMessages(messages: readonly ChatMessage[]): ImageContentPart[] {
  return messages.flatMap((message) => (message.role === "user" ? userMessageImages(message) : []))
}

export function displayUserMessage(message: UserChatMessage): string {
  const text = userMessageText(message)
  const attachments = userMessageAttachments(message).map((attachment) =>
    attachment.type === "image" ? `📎 ${attachment.name}` : `📄 ${attachment.name}`,
  )
  return [text, ...attachments].filter(Boolean).join("\n")
}

export function userMessageContentChars(message: UserChatMessage): number {
  return (
    userMessageText(message).length +
    userMessageImages(message).length * ESTIMATED_IMAGE_TOKENS * CHARS_PER_TOKEN +
    userMessageDocuments(message).reduce((total, document) => total + formatDocumentForModel(document).length, 0)
  )
}

/** Produces model-readable content without copying base64 attachment data into generated prompts. */
export function summarizeUserMessage(message: UserChatMessage): string {
  const text = userMessageText(message)
  const attachments = userMessageAttachments(message).map((attachment) =>
    attachment.type === "image"
      ? `[Image: ${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)]`
      : formatDocumentForModel(attachment),
  )
  return [text, ...attachments].filter(Boolean).join("\n")
}

export function formatDocumentForModel(document: DocumentContentPart) {
  const metadata = JSON.stringify({
    name: document.name,
    sha256: document.sha256, // Lets save_attachment distinguish sources with the same filename without exposing bytes.
    mimeType: document.mimeType,
    sizeBytes: document.sizeBytes,
    ...(document.pageCount === undefined ? {} : { pages: document.pageCount }),
    truncated: document.truncated,
  })
  const truncation = document.truncated ? "\n[Extraction was truncated at Otis's document text limit.]" : ""
  return `[Attached document ${metadata}]\n--- BEGIN EXTRACTED DOCUMENT TEXT ---\n${document.extractedText}${truncation}\n--- END EXTRACTED DOCUMENT TEXT ---`
}
