import type { UserChatMessage } from "../inference/types.js"

export type SteeringSource = {
  drain(): Promise<UserChatMessage[]>
  drainOrClose(): Promise<UserChatMessage[]>
  close(): Promise<UserChatMessage[]>
}

export type SteeringAcceptance = { accepted: false } | { accepted: true; persisted: Promise<void> }

type PendingSteer = {
  message: UserChatMessage
  persisted: Promise<void>
  onConsumed?: () => void
}

/**
 * Owns user messages aimed at an active turn. Accepted messages become visible
 * to the agent only after their admission has been durably recorded.
 */
export class SteeringInbox implements SteeringSource {
  #accepting = true
  readonly #pending: PendingSteer[] = []

  constructor(private readonly admit: (message: UserChatMessage) => Promise<void>) {}

  accept(message: UserChatMessage, onConsumed?: () => void): SteeringAcceptance {
    if (!this.#accepting) return { accepted: false }

    const persisted = Promise.resolve().then(() => this.admit(message))
    this.#pending.push({ message, persisted, onConsumed })
    return { accepted: true, persisted }
  }

  async drain() {
    const pending = this.#pending.splice(0)
    await Promise.all(pending.map((item) => item.persisted))
    for (const item of pending) item.onConsumed?.()
    return pending.map((item) => item.message)
  }

  drainOrClose() {
    if (this.#pending.length > 0) return this.drain()
    this.#accepting = false
    return Promise.resolve([])
  }

  close() {
    this.#accepting = false
    return this.drain()
  }
}
