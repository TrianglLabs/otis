/** A rejected input, as opposed to a response that exhausted its output budget. */
export class ContextOverflowError extends Error {
  constructor(
    message: string,
    readonly contextLength?: number,
  ) {
    super(message)
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

const OVERFLOW_DESCRIPTION =
  /(?:maximum context length|input length exceeds the context length|exceeds the available context size|context (?:length|size) (?:has been )?exceeded|prompt too long: \d+ tokens exceeds max context window of \d+ tokens|trying to keep the first \d+ tokens when context overflows|cannot truncate prompt with n_keep)/i

// Read only the limit of this rejected request, never the input count or an output-token cap.
const REPORTED_CONTEXT_LIMIT =
  /(?:max(?:imum)? context (?:length|size|window)|context length)(?:\s+(?:is|of))?(?:\s+only)?\s*[:=]?\s*([\d,]+)/i

export function inferenceError(message: string, detail: unknown, status?: number): Error {
  if (status !== undefined && status !== 400 && status !== 413) return new Error(message)
  const error = isRecord(detail) ? detail : undefined
  const description =
    typeof error?.message === "string"
      ? error.message
      : typeof error?.detail === "string"
        ? error.detail
        : typeof detail === "string"
          ? detail
          : ""
  const overflow =
    error?.code === "context_length_exceeded" ||
    error?.type === "context_length_exceeded" ||
    error?.type === "exceed_context_size_error" ||
    OVERFLOW_DESCRIPTION.test(description)
  if (!overflow) return new Error(message)
  const match = REPORTED_CONTEXT_LIMIT.exec(description)
  const limit = error?.n_ctx ?? (match ? Number(match[1].replaceAll(",", "")) : undefined)
  return new ContextOverflowError(message, positiveInteger(limit))
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
