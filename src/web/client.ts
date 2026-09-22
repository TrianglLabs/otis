type ParallelClientConfig = {
  url?: string
  fetch?: typeof fetch
}

type WebSearchOptions = {
  objective: string
  searchQueries: string[]
  clientModel?: string
  sessionId?: string
  signal?: AbortSignal
}

type WebSearchResult = {
  url: string
  title?: string
  publishDate?: string
  excerpts: string[]
}

type WebSearchResponse = {
  searchId: string
  sessionId: string
  results: WebSearchResult[]
  warnings: string[]
}

type WebReadOptions = {
  url: string
  objective?: string
  clientModel?: string
  sessionId?: string
  signal?: AbortSignal
}

type WebReadResult = {
  url: string
  title?: string
  excerpts: string[]
  fullContent?: string
}

type WebReadError = {
  url: string
  type: string
  status?: number
  content?: string
}

type WebReadResponse = {
  extractId: string
  sessionId: string
  results: WebReadResult[]
  errors: WebReadError[]
  warnings: string[]
}

const DEFAULT_MCP_URL = "https://search.parallel.ai/mcp"
const MAX_SEARCH_QUERIES = 3
const MAX_SESSION_ID_CHARS = 100
const MAX_ERROR_CHARS = 2_000

export class ParallelClient {
  readonly #url: string
  readonly #fetch: typeof fetch

  constructor(config: ParallelClientConfig = {}) {
    const url = parseURL(config.url ?? DEFAULT_MCP_URL, "Parallel MCP URL")
    const localHTTP =
      url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")
    if (url.protocol !== "https:" && !localHTTP) throw new Error("Parallel MCP URL must use HTTPS.")
    url.search = ""
    url.hash = ""
    this.#url = url.toString()
    this.#fetch = config.fetch ?? fetch
  }

  async search(options: WebSearchOptions): Promise<WebSearchResponse> {
    const objective = required(options.objective, "Web search objective")
    const queries = options.searchQueries.map((query) => required(query, "Web search query"))
    if (queries.length === 0 || queries.length > MAX_SEARCH_QUERIES)
      throw new Error(`Web search requires between 1 and ${MAX_SEARCH_QUERIES} queries.`)
    const value = await this.#call(
      "web_search",
      { objective, search_queries: queries, ...requestContext(options) },
      options.signal,
    )
    if (!isRecord(value) || !Array.isArray(value.results))
      throw new Error("Parallel search response was invalid.")
    return {
      searchId: requiredResponseString(value.search_id, "search_id"),
      sessionId: requiredResponseString(value.session_id, "session_id"),
      results: value.results.map((result): WebSearchResult => {
        if (!isRecord(result))
          throw new Error("Parallel search response contained an invalid result.")
        const title = cleanUnknown(result.title)
        const publishDate = cleanUnknown(result.publish_date)
        return {
          url: validPublicURL(requiredResponseString(result.url, "result URL")),
          ...(title ? { title } : {}),
          ...(publishDate ? { publishDate } : {}),
          excerpts: optionalStringArray(result.excerpts),
        }
      }),
      warnings: parseWarnings(value.warnings),
    }
  }

  async read(options: WebReadOptions): Promise<WebReadResponse> {
    const objective = options.objective?.trim()
    const value = await this.#call(
      "web_fetch",
      {
        urls: [validPublicURL(options.url)],
        ...(objective ? { objective } : {}),
        ...requestContext(options),
      },
      options.signal,
    )
    if (!isRecord(value) || !Array.isArray(value.results))
      throw new Error("Parallel extract response was invalid.")
    return {
      extractId: requiredResponseString(value.extract_id, "extract_id"),
      sessionId: requiredResponseString(value.session_id, "session_id"),
      results: value.results.map((result): WebReadResult => {
        if (!isRecord(result))
          throw new Error("Parallel extract response contained an invalid result.")
        const title = cleanUnknown(result.title)
        const fullContent = cleanUnknown(result.full_content)
        return {
          url: validPublicURL(requiredResponseString(result.url, "result URL")),
          ...(title ? { title } : {}),
          excerpts: optionalStringArray(result.excerpts),
          ...(fullContent ? { fullContent } : {}),
        }
      }),
      errors: (Array.isArray(value.errors) ? value.errors : []).map((error): WebReadError => {
        if (!isRecord(error))
          throw new Error("Parallel extract response contained an invalid error.")
        const status = error.http_status_code
        const content = cleanUnknown(error.content)
        return {
          url: requiredResponseString(error.url, "error URL"),
          type: requiredResponseString(error.error_type, "error type"),
          ...(typeof status === "number" && Number.isInteger(status) && status > 0
            ? { status }
            : {}),
          ...(content ? { content } : {}),
        }
      }),
      warnings: parseWarnings(value.warnings),
    }
  }

  async #call(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    const response = await this.#fetch(this.#url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
      signal,
    })
    const body = await response.text().catch(() => "")
    if (!response.ok) {
      const detail = (body || response.statusText).slice(0, MAX_ERROR_CHARS)
      throw new Error(`Parallel request failed with HTTP ${response.status}: ${detail}`)
    }
    // The envelope is either a plain JSON object or the first JSON data line of an SSE stream.
    const json = body.trim().startsWith("{")
      ? body.trim()
      : body
          .split(/\r?\n/)
          .map((line) => (line.startsWith("data:") ? line.slice(5).trim() : ""))
          .find((data) => data.startsWith("{"))
    const envelope = parseJson(json ?? "", "Parallel MCP response")
    if (!isRecord(envelope)) throw new Error("Parallel MCP response was not valid JSON.")
    if (isRecord(envelope.error))
      throw new Error(cleanUnknown(envelope.error.message) ?? "Parallel MCP request failed.")
    const result = envelope.result
    if (!isRecord(result)) throw new Error("Parallel MCP response was missing a result.")
    const text = Array.isArray(result.content)
      ? result.content
          .map((item) => (isRecord(item) ? cleanUnknown(item.text) : undefined))
          .find(Boolean)
      : undefined
    if (result.isError === true) throw new Error(text ?? "Parallel MCP tool returned an error.")
    if (!text) throw new Error("Parallel MCP response was missing text content.")
    return parseJson(text, "Parallel MCP result")
  }
}

function requestContext(options: { clientModel?: string; sessionId?: string }) {
  const modelName = options.clientModel?.trim()
  const sessionId = options.sessionId?.trim().slice(0, MAX_SESSION_ID_CHARS)
  return {
    ...(modelName ? { model_name: modelName } : {}),
    ...(sessionId ? { session_id: sessionId } : {}),
  }
}

function validPublicURL(value: string) {
  const url = parseURL(value, "Web URL")
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("Web URL must use HTTP or HTTPS.")
  return url.toString()
}

function parseURL(value: string, label: string) {
  const trimmed = required(value, label)
  try {
    return new URL(trimmed)
  } catch {
    throw new Error(`${label} is invalid.`)
  }
}

function required(value: string, label: string) {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} is required.`)
  return trimmed
}

function requiredResponseString(value: unknown, name: string) {
  const result = cleanUnknown(value)
  if (!result) throw new Error(`Parallel response was missing ${name}.`)
  return result
}

function optionalStringArray(value: unknown) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("Parallel response contained an invalid string list.")
  }
  return value.map((item) => item.trim()).filter(Boolean)
}

function parseWarnings(value: unknown) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error("Parallel response contained invalid warnings.")
  return value.map((warning) => {
    if (!isRecord(warning)) throw new Error("Parallel response contained an invalid warning.")
    return requiredResponseString(warning.message, "warning message")
  })
}

function parseJson(text: string, label: string) {
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(`${label} was not valid JSON.`)
  }
}

function cleanUnknown(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
