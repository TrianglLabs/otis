import { describe, expect, it } from "vitest"
import {
  ContextOverflowError,
  inferenceError,
  inferenceResponseError,
} from "../../src/inference/errors.js"
import { createPairClient } from "../../src/inference/pair.js"
import { parseChatCompletionStream } from "../../src/inference/stream-parser.js"

describe("context overflow errors", () => {
  it.each([
    { type: "exceed_context_size_error", message: "request is too large", n_ctx: 8192 },
    { code: "context_length_exceeded", message: "too many tokens" },
    { message: "the input length exceeds the context length" },
    {
      message: "Prompt too long: 9000 tokens exceeds max context window of 8192 tokens",
      type: "invalid_request_error",
      code: null,
    },
    { detail: "Prompt too long: 9000 tokens exceeds max context window of 8192 tokens" },
    {
      message:
        "Trying to keep the first 9000 tokens when context overflows. However, the model is loaded with context length of only 8192 tokens.",
    },
  ])("recognizes an explicit input rejection: %j", async (error) => {
    expect(
      await inferenceResponseError(Response.json({ error }, { status: 400 }), "Local model"),
    ).toBeInstanceOf(ContextOverflowError)
  })

  it.each([
    "http",
    "stream",
  ])("reports an undersized LM Studio allocation from %s without compaction retries", async (mode) => {
    const error = {
      message:
        "Trying to keep the first 40000 tokens when context overflows. However, the model is loaded with context length of only 32768 tokens.",
    }
    const client = createPairClient({
      engine: "lmstudio",
      model: "chat",
      baseURL: "http://127.0.0.1:1234",
      fetch: async () =>
        mode === "http"
          ? Response.json({ error }, { status: 400 })
          : new Response(`data: ${JSON.stringify({ error })}\n\n`),
    })
    const response = client.complete([])
    await expect(response).rejects.toThrow("Otis requires at least 65,536 tokens (64K)")
    await expect(response).rejects.not.toBeInstanceOf(ContextOverflowError)
  })

  it("extracts only reported context limits, not prompt sizes or output caps", () => {
    expect(
      inferenceError(
        "overflow",
        { message: "Prompt too long: 90000 tokens exceeds max context window of 65536 tokens" },
        400,
      ),
    ).toMatchObject({ contextLength: 65536 })
    expect(
      inferenceError("overflow", { type: "exceed_context_size_error", n_ctx: 131072 }, 400),
    ).toMatchObject({
      contextLength: 131072,
    })
    expect(
      inferenceError(
        "overflow",
        { code: "context_length_exceeded", message: "Input 90000 tokens is too long" },
        400,
      ),
    ).toMatchObject({ contextLength: undefined })
    expect(
      inferenceError("output", { message: "maximum output tokens is 8192" }, 400),
    ).not.toBeInstanceOf(ContextOverflowError)
  })

  it("recognizes a rejection delivered before the SSE response starts", async () => {
    const response = new Response(
      'data: {"error":{"type":"exceed_context_size_error","message":"too large"}}\n\n',
    )
    if (!response.body) throw new Error("Missing response body")
    await expect(parseChatCompletionStream(response.body).next()).rejects.toBeInstanceOf(
      ContextOverflowError,
    )
  })

  it.each([
    401, 429, 500, 503,
  ])("does not classify HTTP %s as a recoverable input rejection", async (status) => {
    const error = await inferenceResponseError(
      Response.json({ error: { code: "context_length_exceeded" } }, { status }),
      "Local model",
    )
    expect(error).not.toBeInstanceOf(ContextOverflowError)
    expect(error.message).toContain(`HTTP ${status}`)
  })

  it("does not retry allocation failures or unrelated invalid requests", () => {
    for (const message of [
      "Failed to allocate context",
      "Invalid tool schema",
      "Model not found",
      "oMLX prefill memory guard rejected this prompt",
      "max context window setting is invalid",
    ]) {
      expect(inferenceError(message, { message }, 400)).not.toBeInstanceOf(ContextOverflowError)
    }
  })
})
