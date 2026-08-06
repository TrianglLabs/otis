import type { ChatMessage, ImageContentPart, UserChatMessage } from "./types.js"

export const ESTIMATED_IMAGE_TOKENS = 1_024
const CHARS_PER_TOKEN = 4

export function createUserMessage(text: string, images: readonly ImageContentPart[] = []): UserChatMessage {
  if (images.length === 0) return { role: "user", content: text }
  return {
    role: "user",
    content: [...images, ...(text ? [{ type: "text" as const, text }] : [])],
  }
}

export function userMessageText(message: UserChatMessage): string {
  if (typeof message.content === "string") return message.content
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
}

export function userMessageImages(message: UserChatMessage): ImageContentPart[] {
  return typeof message.content === "string" ? [] : message.content.filter((part) => part.type === "image")
}

export function messagesContainImages(messages: readonly ChatMessage[]): boolean {
  return messages.some((message) => message.role === "user" && userMessageImages(message).length > 0)
}

export function imageAttachmentsFromMessages(messages: readonly ChatMessage[]): ImageContentPart[] {
  return messages.flatMap((message) => (message.role === "user" ? userMessageImages(message) : []))
}

export function displayUserMessage(message: UserChatMessage): string {
  const text = userMessageText(message)
  const attachments = userMessageImages(message).map((image) => `📎 ${image.name}`)
  return [text, ...attachments].filter(Boolean).join("\n")
}

export function userMessageContentChars(message: UserChatMessage): number {
  return userMessageText(message).length + userMessageImages(message).length * ESTIMATED_IMAGE_TOKENS * CHARS_PER_TOKEN
}

/** Produces model-readable metadata without copying base64 image data into generated prompts. */
export function summarizeUserMessage(message: UserChatMessage): string {
  const text = userMessageText(message)
  const images = userMessageImages(message).map(
    (image) => `[Image: ${image.name} (${image.mimeType}, ${image.sizeBytes} bytes)]`,
  )
  return [text, ...images].filter(Boolean).join("\n")
}
