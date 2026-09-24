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

/**
 * An error as a sentence for the person using Otis: network and file system failures name what
 * went wrong instead of their code, a rejected context says so, and every other error already
 * reads as one.
 */
export function describeError(error: unknown): string {
  if (error instanceof ContextOverflowError)
    return "The conversation no longer fits the model's context window."
  // Bun's fetch fails with the system error itself; Node's wraps it as the cause.
  const failure = [
    error,
    error instanceof Error && error.message === "fetch failed" ? error.cause : undefined,
  ].find(
    (candidate): candidate is Record<string, unknown> =>
      isRecord(candidate) && typeof candidate.code === "string",
  )
  const path = typeof failure?.path === "string" ? failure.path : "A required file"
  switch (failure?.code) {
    case "ECONNREFUSED":
      return failure.address && failure.port
        ? `Nothing is listening at ${failure.address}:${failure.port}.`
        : "Nothing is listening at that address."
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `${
        failure.hostname ? `The address ${failure.hostname}` : "The server's address"
      } could not be resolved. Check the network connection.`
    case "ECONNRESET":
    case "EPIPE":
      return "The connection was closed unexpectedly."
    case "ETIMEDOUT":
    case "UND_ERR_CONNECT_TIMEOUT":
    case "UND_ERR_HEADERS_TIMEOUT":
    case "UND_ERR_BODY_TIMEOUT":
      return "The connection timed out."
    case "ENOENT":
      return `${path} does not exist.`
    case "EACCES":
    case "EPERM":
      return `Permission denied for ${path}.`
    case "ENOSPC":
      return "The disk is full."
    case "EROFS":
      return "The disk is read-only."
    case "EISDIR":
      return `${path} is a folder, not a file.`
    case "ENOTDIR":
      return `${path} is not a folder.`
  }
  if (error instanceof Error && error.message === "fetch failed")
    return "The server could not be reached. Check the network connection."
  return error instanceof Error ? error.message : String(error)
}

const OVERFLOW_DESCRIPTION =
  /(?:maximum context length|input length exceeds the context length|exceeds the available context size|context (?:length|size) (?:has been )?exceeded|prompt too long: \d+ tokens exceeds max context window of \d+ tokens|trying to keep the first \d+ tokens when context overflows|cannot truncate prompt with n_keep)/i

// Read only the limit of this rejected request, never the input count or an output-token cap.
const REPORTED_CONTEXT_LIMIT =
  /(?:max(?:imum)? context (?:length|size|window)|context length)(?:\s+(?:is|of))?(?:\s+only)?\s*[:=]?\s*([\d,]+)/i

/** The provider's own sentence about a rejected request, wherever the server put it. */
function detailText(detail: unknown) {
  const error = isRecord(detail) ? detail : undefined
  return typeof error?.message === "string"
    ? error.message
    : typeof error?.detail === "string"
      ? error.detail
      : typeof detail === "string"
        ? detail
        : ""
}

export function inferenceError(message: string, detail: unknown, status?: number): Error {
  if (status !== undefined && status !== 400 && status !== 413) return new Error(message)
  const error = isRecord(detail) ? detail : undefined
  const description = detailText(detail)
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
  // A short plain-text detail is often the actionable part (a model name, a quota); a page of
  // HTML or JSON never is.
  const brief = detailText(detail).replace(/\s+/g, " ").trim().slice(0, 200)
  const suffix =
    brief && !brief.startsWith("<") && !brief.startsWith("{")
      ? `: ${brief.replace(/\.$/, "")}.`
      : "."
  const { status } = response
  const message =
    status === 401 || status === 403
      ? `${label} rejected the API key${suffix}`
      : status === 429
        ? `${label} is rate limiting requests; try again in a moment${suffix}`
        : status >= 500
          ? `${label} is unavailable right now (HTTP ${status}); try again in a moment${suffix}`
          : `${label} rejected the request${suffix === "." ? ` (HTTP ${status}).` : suffix}`
  return inferenceError(message, detail, status)
}
