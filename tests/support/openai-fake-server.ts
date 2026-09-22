import { createServer, type IncomingHttpHeaders } from "node:http"
import type { AddressInfo } from "node:net"

export type RecordedRequest = {
  path: string
  headers: IncomingHttpHeaders
  body: Record<string, unknown>
}

/**
 * One scripted answer, consumed in request order: an SSE stream of chat-completion chunks
 * (terminated by `[DONE]`), a JSON error status, or a stream that sends its chunks and then
 * stays open until the server is closed. (Under Bun, node:http cannot observe a client abort
 * once the request body has been read, so a stalled reply is torn down by `close()`.)
 */
export type FakeReply =
  | { kind: "sse"; chunks: unknown[] }
  | { kind: "status"; status: number; json: unknown }
  | { kind: "stall"; chunks: unknown[] }

export type FakeOpenAIServer = {
  /** The chat-completions URL clients are pointed at. */
  url: string
  requests: RecordedRequest[]
  replies: FakeReply[]
  close(): Promise<void>
}

/**
 * An in-process server speaking the OpenAI chat-completions wire format on loopback. Every
 * request is recorded with its parsed JSON body; replies come from the `replies` queue.
 */
export async function startFakeOpenAIServer(): Promise<FakeOpenAIServer> {
  const requests: RecordedRequest[] = []
  const replies: FakeReply[] = []
  const server = createServer(async (request, response) => {
    let raw = ""
    for await (const chunk of request) raw += chunk
    requests.push({ path: request.url ?? "", headers: request.headers, body: JSON.parse(raw) })
    const reply = replies.shift()
    if (!reply) {
      response.writeHead(500, { "content-type": "text/plain" })
      response.end("no scripted reply")
      return
    }
    if (reply.kind === "status") {
      response.writeHead(reply.status, { "content-type": "application/json" })
      response.end(JSON.stringify(reply.json))
      return
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    for (const chunk of reply.chunks) {
      response.write(`data: ${JSON.stringify(chunk)}\n\n`)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    if (reply.kind === "sse") response.end("data: [DONE]\n\n")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    requests,
    replies,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

/** A streamed chat-completion chunk with one choice delta. */
export function delta(
  value: Record<string, unknown>,
  finishReason?: string,
): Record<string, unknown> {
  return {
    choices: [{ delta: value, ...(finishReason ? { finish_reason: finishReason } : {}) }],
  }
}

/** The trailing usage chunk servers send with `stream_options.include_usage`. */
export function usageChunk(promptTokens: number, completionTokens: number) {
  return {
    choices: [],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  }
}
