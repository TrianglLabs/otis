import { describe, expect, it, vi } from "vitest"
import { checkLlamaGeneration } from "../../src/inference/llama-readiness.js"

const endpoint = "http://127.0.0.1:18765/v1/chat/completions"
const options = () => ({ model: "local-model", inferenceURL: endpoint, signal: new AbortController().signal })

function completion(delta: Record<string, unknown>, finishReason: string | null = "stop") {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finishReason }] })}\n\ndata: [DONE]\n\n`,
  )
}

describe("managed llama.cpp generation check", () => {
  it("sends only a bounded startup prompt and accepts generated text", async () => {
    const request = vi.fn(async () => completion({ content: "Hello!" }))
    await checkLlamaGeneration({ ...options(), fetch: request as unknown as typeof fetch })
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(endpoint)
    expect(init).toMatchObject({ method: "POST", redirect: "error" })
    expect(JSON.parse(String(init.body))).toEqual({
      model: "local-model",
      messages: [{ role: "user", content: "Say hello." }],
      stream: true,
      max_tokens: 32,
    })
    expect(request).toHaveBeenCalledOnce()
  })

  it.each([
    "reasoning_content",
    "reasoning",
    "reasoning_text",
  ])("accepts %s when a reasoning model reaches the probe output limit", async (field) => {
    const request = vi.fn(async () => completion({ [field]: "The user asked for a greeting." }, "length"))
    await expect(
      checkLlamaGeneration({ ...options(), fetch: request as unknown as typeof fetch }),
    ).resolves.toBeUndefined()
  })

  it.each([
    ["empty output", () => completion({ content: " \n" }), "produced no text or reasoning"],
    ["broken stream", () => completion({ content: "Hello" }, null), "did not finish"],
    ["unexpected finish", () => completion({ content: "Hello" }, "content_filter"), "did not finish"],
    ["invalid stream", () => new Response("data: {invalid}\n\n"), "Invalid inference stream"],
    ["plain health response", () => new Response("ok"), "produced no text or reasoning"],
    ["missing body", () => new Response(null), "no response body"],
    [
      "HTTP error",
      () => Response.json({ error: { message: "failed to allocate compute buffer" } }, { status: 500 }),
      "HTTP 500",
    ],
    ["stream error", () => new Response('data: {"error":{"message":"decode failed"}}\n\n'), "decode failed"],
    [
      "unexpected tool call",
      () =>
        completion(
          { tool_calls: [{ index: 0, id: "call_1", function: { name: "shell", arguments: "{}" } }] },
          "tool_calls",
        ),
      "unexpected tool call",
    ],
  ] as const)("rejects %s without retrying", async (_label, response, message) => {
    const request = vi.fn(async () => response())
    await expect(checkLlamaGeneration({ ...options(), fetch: request as unknown as typeof fetch })).rejects.toThrow(
      message,
    )
    expect(request).toHaveBeenCalledOnce()
  })

  it.each(["headers", "body"])("times out while waiting for response %s", async (stage) => {
    let requestSignal: AbortSignal | undefined
    const request = (async (_input, init) => {
      requestSignal = init?.signal ?? undefined
      if (!requestSignal) throw new Error("Missing request signal")
      const signal = requestSignal
      if (stage === "headers") {
        return await new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        })
      }
      return new Response(
        new ReadableStream({
          start(controller) {
            signal.addEventListener("abort", () => controller.error(signal.reason), { once: true })
          },
        }),
      )
    }) as typeof fetch
    await expect(checkLlamaGeneration({ ...options(), fetch: request, timeoutMs: 20 })).rejects.toThrow(
      "generation check timed out",
    )
    expect(requestSignal?.aborted).toBe(true)
  })

  it("preserves caller cancellation instead of reporting a failed model", async () => {
    const abort = new AbortController()
    const request = vi.fn(async () => {
      abort.abort()
      throw abort.signal.reason
    })
    await expect(
      checkLlamaGeneration({ ...options(), signal: abort.signal, fetch: request as unknown as typeof fetch }),
    ).rejects.toMatchObject({ name: "AbortError" })
  })
})
