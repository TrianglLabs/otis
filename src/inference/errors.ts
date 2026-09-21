/** A rejected input, as opposed to a response that exhausted its output budget. */
export class ContextOverflowError extends Error {
  constructor(
    message: string,
    readonly contextLength?: number,
  ) {
    super(message)
  }
}

export function inferenceError(message: string, detail: unknown, status?: number): Error {
  if (status !== undefined && status !== 400 && status !== 413) return new Error(message)
  const error = typeof detail === "object" && detail !== null ? (detail as Record<string, unknown>) : undefined
  const code = error?.code
  const type = error?.type
  const description =
    typeof error?.message === "string"
      ? error.message
      : typeof error?.detail === "string"
        ? error.detail
        : typeof detail === "string"
          ? detail
          : ""
  if (
    code === "context_length_exceeded" ||
    type === "context_length_exceeded" ||
    type === "exceed_context_size_error" ||
    /(?:maximum context length|input length exceeds the context length|exceeds the available context size|context (?:length|size) (?:has been )?exceeded|prompt too long: \d+ tokens exceeds max context window of \d+ tokens|trying to keep the first \d+ tokens when context overflows|cannot truncate prompt with n_keep)/i.test(
      description,
    )
  )
    return new ContextOverflowError(message, reportedContextLength(error, description))
  return new Error(message)
}

function reportedContextLength(error: Record<string, unknown> | undefined, description: string) {
  // Read only the limit of this rejected request, never the input count or an output-token cap.
  const match =
    /(?:max(?:imum)? context (?:length|size|window)|context length)(?:\s+(?:is|of))?(?:\s+only)?\s*[:=]?\s*([\d,]+)/i.exec(
      description,
    )
  const value = error?.n_ctx ?? (match ? Number(match[1].replaceAll(",", "")) : undefined)
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

export async function inferenceResponseError(response: Response, label: string): Promise<Error> {
  const body = await response.text().catch(() => "")
  let detail: unknown = body
  try {
    const parsed = JSON.parse(body)
    detail = parsed?.error ?? parsed
  } catch {
    /* Some compatible servers return a plain-text error. */
  }
  return inferenceError(
    `${label} request failed with HTTP ${response.status}: ${body.slice(0, 2000) || response.statusText}`,
    detail,
    response.status,
  )
}
