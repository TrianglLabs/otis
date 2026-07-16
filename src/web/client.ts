import type {
  ParallelClientConfig,
  WebReadError,
  WebReadOptions,
  WebReadResponse,
  WebReadResult,
  WebSearchOptions,
  WebSearchResponse,
  WebSearchResult,
} from "./types.js"

const DEFAULT_BASE_URL = "https://api.parallel.ai"
const MAX_RESPONSE_CHARS = 16_000
const MAX_SEARCH_QUERIES = 3

export class ParallelClient {
  readonly #apiKey: string
  readonly #baseURL: string
  readonly #fetch: typeof fetch

  constructor(config: ParallelClientConfig) {
    this.#apiKey = required(config.apiKey, "Parallel API key")
    this.#baseURL = validBaseURL(config.baseURL ?? DEFAULT_BASE_URL)
    this.#fetch = config.fetch ?? fetch
  }

  async search(options: WebSearchOptions): Promise<WebSearchResponse> {
    const objective = required(options.objective, "Web search objective")
    const searchQueries = requiredSearchQueries(options.searchQueries)
    const value = await this.#post(
      "/v1/search",
      {
        objective,
        search_queries: searchQueries,
        mode: "basic",
        max_chars_total: MAX_RESPONSE_CHARS,
        ...optionalRequestContext(options),
      },
      options.signal,
    )
    return parseSearchResponse(value)
  }

  async read(options: WebReadOptions): Promise<WebReadResponse> {
    const url = validPublicURL(options.url)
    const value = await this.#post(
      "/v1/extract",
      {
        urls: [url],
        max_chars_total: MAX_RESPONSE_CHARS,
        advanced_settings: { full_content: { max_chars_per_result: MAX_RESPONSE_CHARS } },
        ...(clean(options.objective) ? { objective: clean(options.objective) } : {}),
        ...optionalRequestContext(options),
      },
      options.signal,
    )
    return parseReadResponse(value)
  }

  async #post(path: string, body: unknown, signal?: AbortSignal) {
    const response = await this.#fetch(new URL(path, this.#baseURL), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-api-key": this.#apiKey,
      },
      body: JSON.stringify(body),
      signal,
    })
    if (!response.ok) {
      throw new Error(`Parallel request failed with HTTP ${response.status}: ${await responseText(response)}`)
    }
    try {
      return (await response.json()) as unknown
    } catch {
      throw new Error("Parallel response was not valid JSON.")
    }
  }
}

function optionalRequestContext(options: { clientModel?: string; sessionId?: string }) {
  const clientModel = clean(options.clientModel)
  const sessionId = clean(options.sessionId)
  return {
    ...(clientModel ? { client_model: clientModel } : {}),
    ...(sessionId ? { session_id: sessionId } : {}),
  }
}

function parseSearchResponse(value: unknown): WebSearchResponse {
  if (!isRecord(value) || !Array.isArray(value.results)) throw new Error("Parallel search response was invalid.")
  return {
    searchId: requiredResponseString(value.search_id, "search_id"),
    sessionId: requiredResponseString(value.session_id, "session_id"),
    results: value.results.map(parseSearchResult),
    warnings: parseWarnings(value.warnings),
  }
}

function parseSearchResult(value: unknown): WebSearchResult {
  if (!isRecord(value)) throw new Error("Parallel search response contained an invalid result.")
  return {
    url: validPublicURL(requiredResponseString(value.url, "result URL")),
    ...(cleanUnknown(value.title) ? { title: cleanUnknown(value.title) } : {}),
    ...(cleanUnknown(value.publish_date) ? { publishDate: cleanUnknown(value.publish_date) } : {}),
    excerpts: optionalStringArray(value.excerpts),
  }
}

function parseReadResponse(value: unknown): WebReadResponse {
  if (!isRecord(value) || !Array.isArray(value.results) || !Array.isArray(value.errors)) {
    throw new Error("Parallel extract response was invalid.")
  }
  return {
    extractId: requiredResponseString(value.extract_id, "extract_id"),
    sessionId: requiredResponseString(value.session_id, "session_id"),
    results: value.results.map(parseReadResult),
    errors: value.errors.map(parseReadError),
    warnings: parseWarnings(value.warnings),
  }
}

function parseReadResult(value: unknown): WebReadResult {
  if (!isRecord(value)) throw new Error("Parallel extract response contained an invalid result.")
  const fullContent = cleanUnknown(value.full_content)
  return {
    url: validPublicURL(requiredResponseString(value.url, "result URL")),
    ...(cleanUnknown(value.title) ? { title: cleanUnknown(value.title) } : {}),
    excerpts: optionalStringArray(value.excerpts),
    ...(fullContent ? { fullContent } : {}),
  }
}

function parseReadError(value: unknown): WebReadError {
  if (!isRecord(value)) throw new Error("Parallel extract response contained an invalid error.")
  const status = positiveInteger(value.http_status_code)
  const content = cleanUnknown(value.content)
  return {
    url: requiredResponseString(value.url, "error URL"),
    type: requiredResponseString(value.error_type, "error type"),
    ...(status ? { status } : {}),
    ...(content ? { content } : {}),
  }
}

function requiredSearchQueries(value: string[]) {
  if (!Array.isArray(value)) throw new Error("Web search queries are required.")
  const queries = value.map((query) => required(query, "Web search query"))
  if (queries.length === 0 || queries.length > MAX_SEARCH_QUERIES) {
    throw new Error(`Web search requires between 1 and ${MAX_SEARCH_QUERIES} queries.`)
  }
  return queries
}

function validBaseURL(value: string) {
  const url = parseURL(value, "Parallel base URL")
  const localHTTP = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")
  if (url.protocol !== "https:" && !localHTTP) throw new Error("Parallel base URL must use HTTPS.")
  url.pathname = "/"
  url.search = ""
  url.hash = ""
  return url.toString()
}

function validPublicURL(value: string) {
  const url = parseURL(value, "Web URL")
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Web URL must use HTTP or HTTPS.")
  return url.toString()
}

function parseURL(value: string, label: string) {
  try {
    return new URL(required(value, label))
  } catch (error) {
    if (error instanceof Error && error.message.endsWith("is required.")) throw error
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

async function responseText(response: Response) {
  try {
    return (await response.text()).slice(0, 2_000) || response.statusText
  } catch {
    return response.statusText
  }
}

function clean(value: string | undefined) {
  return value?.trim() || undefined
}

function cleanUnknown(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
