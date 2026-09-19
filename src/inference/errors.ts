/** A rejected input, as opposed to a response that exhausted its output budget. */
export class ContextOverflowError extends Error {}

export function inferenceError(message: string, detail: unknown, status?: number): Error {
  if (status !== undefined && status !== 400 && status !== 413) return new Error(message)
  const error = typeof detail === "object" && detail !== null ? (detail as Record<string, unknown>) : undefined
  const code = error?.code
  const type = error?.type
  const description = typeof error?.message === "string" ? error.message : typeof detail === "string" ? detail : ""
  if (
    code === "context_length_exceeded" ||
    type === "context_length_exceeded" ||
    type === "exceed_context_size_error" ||
    /(?:maximum context length|input length exceeds the context length|exceeds the available context size|context (?:length|size) (?:has been )?exceeded)/i.test(
      description,
    )
  )
    return new ContextOverflowError(message)
  return new Error(message)
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
