import { describe, expect, it } from "vitest"
import { ContextOverflowError, inferenceError, inferenceResponseError } from "../../src/inference/errors.js"
import { LlamaCppClient } from "../../src/inference/local-client.js"
import { parseChatCompletionStream } from "../../src/inference/stream-parser.js"

describe("context overflow errors", () => {
  it.each([
    { type: "exceed_context_size_error", message: "request is too large", n_ctx: 8192 },
    { code: "context_length_exceeded", message: "too many tokens" },
    { message: "the input length exceeds the context length" },
  ])("recognizes an explicit input rejection: %j", async (error) => {
    const client = new LlamaCppClient({
      model: "fake",
      inferenceURL: "http://127.0.0.1:1234/v1/chat/completions",
      fetch: async () => Response.json({ error }, { status: 400 }),
    })
    await expect(client.streamChat({ messages: [] }).next()).rejects.toBeInstanceOf(ContextOverflowError)
  })

  it("recognizes a rejection delivered before the SSE response starts", async () => {
    const response = new Response('data: {"error":{"type":"exceed_context_size_error","message":"too large"}}\n\n')
    if (!response.body) throw new Error("Missing response body")
    await expect(parseChatCompletionStream(response.body).next()).rejects.toBeInstanceOf(ContextOverflowError)
  })

  it.each([401, 429, 500, 503])("does not classify HTTP %s as a recoverable input rejection", async (status) => {
    const error = await inferenceResponseError(
      Response.json({ error: { code: "context_length_exceeded" } }, { status }),
      "Local model",
    )
    expect(error).not.toBeInstanceOf(ContextOverflowError)
    expect(error.message).toContain(`HTTP ${status}`)
  })

  it("does not retry allocation failures or unrelated invalid requests", () => {
    for (const message of ["Failed to allocate context", "Invalid tool schema", "Model not found"]) {
      expect(inferenceError(message, { message }, 400)).not.toBeInstanceOf(ContextOverflowError)
    }
  })
})
