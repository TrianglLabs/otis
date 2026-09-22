import type {
  AssistantContentPart,
  AttachmentContentPart,
  ChatMessage,
  DocumentContentPart,
  ImageContentPart,
  UserChatMessage,
  UserContentPart,
} from "./types.js"

// Token rates per UTF-16 code unit, fitted by least squares to the Qwen2, Llama 3, and LFM2.5
// tokenizers over the corpus in tests/inference/token-estimate.test.ts. BPE tokens are mostly
// space-prefixed words, so a space costs most of a token and a letter little; punctuation tends
// to stand alone, Qwen splits digits singly, CJK text runs 1.3 to 1.6 characters per token,
// other non-ASCII letters about three, and an emoji (two surrogate units) two tokens.
const TOKENS_PER_LETTER = 0.14
const TOKENS_PER_SPACE = 0.45
const TOKENS_PER_SYMBOL = 0.55
const TOKENS_PER_DIGIT = 1
const TOKENS_PER_CJK_UNIT = 0.7
const TOKENS_PER_OTHER_UNIT = 0.3

/** A tokenizer-free estimate of the tokens a text costs, fractional so sums stay unbiased. */
export function estimateTextTokens(text: string): number {
  let tokens = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code === 0x20 || code === 0x0a || code === 0x09 || code === 0x0d) tokens += TOKENS_PER_SPACE
    else if (code > 0x7f) tokens += cjkOrEmoji(code) ? TOKENS_PER_CJK_UNIT : TOKENS_PER_OTHER_UNIT
    else if (code >= 0x30 && code <= 0x39) tokens += TOKENS_PER_DIGIT
    else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a))
      tokens += TOKENS_PER_LETTER
    else tokens += TOKENS_PER_SYMBOL
  }
  return tokens
}

/** CJK ideographs, kana, hangul, and fullwidth forms, plus surrogate halves (emoji). */
function cjkOrEmoji(code: number) {
  return (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xd800 && code <= 0xdfff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef)
  )
}

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
