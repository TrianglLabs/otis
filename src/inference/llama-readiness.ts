import { inferenceResponseError } from "./errors.js"
import { parseChatCompletionStream } from "./stream-parser.js"

const GENERATION_CHECK_TIMEOUT_MS = 120_000

/** Startup-only probe for an Otis-owned server. No conversation, tools, or usage recording. */
export async function checkLlamaGeneration(options: {
  model: string
  inferenceURL: string
  signal: AbortSignal
  fetch?: typeof fetch
  timeoutMs?: number
}): Promise<void> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? GENERATION_CHECK_TIMEOUT_MS)
  const signal = AbortSignal.any([options.signal, timeout])
  let response: Response | undefined
  try {
    signal.throwIfAborted()
    response = await (options.fetch ?? fetch)(options.inferenceURL, {
      method: "POST",
      headers: { accept: "text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({
        model: options.model,
        messages: [{ role: "user", content: "Say hello." }],
        stream: true,
        max_tokens: 32,
      }),
      signal,
      redirect: "error",
    })
    if (!response.ok) throw await inferenceResponseError(response, "Local model generation check")
    if (!response.body) throw new Error("The server returned no response body.")

    let generated = false
    let finished = false
    for await (const event of parseChatCompletionStream(response.body)) {
      signal.throwIfAborted()
      if (event.type === "text_delta" || event.type === "reasoning_delta") {
        if (typeof event.text === "string" && event.text.trim()) generated = true
      }
      if (event.type === "tool_call") throw new Error("The server returned an unexpected tool call.")
      if (event.type === "finish") finished = event.reason === "stop" || event.reason === "length"
    }
    signal.throwIfAborted()
    // A reasoning model may spend the entire probe thinking. A bounded, finished reasoning response
    // still proves generation works; neither a particular answer nor a completed thought is required.
    if (!generated) throw new Error("The server produced no text or reasoning.")
    if (!finished) throw new Error("The server did not finish the generation response.")
  } catch (error) {
    options.signal.throwIfAborted()
    if (timeout.aborted) throw new Error("The local model loaded, but its generation check timed out.")
    throw new Error(
      `The local model loaded, but its generation check failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    await response?.body?.cancel().catch(() => {})
  }
}
