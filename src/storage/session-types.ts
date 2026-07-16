import type { UserChatMessage } from "./session-events.js"

export type SessionOptions = {
  cwd: string
  sessionId?: string
  directory?: string
}

export type PromptAdmission = {
  promptId: string
  message: UserChatMessage
}

export type SessionSummary = {
  id: string
  title: string
  messageCount: number
  updatedAt: string
  mtimeMs: number
}
