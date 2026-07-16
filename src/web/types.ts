export type ParallelClientConfig = {
  apiKey: string
  baseURL?: string
  fetch?: typeof fetch
}

export type WebSearchOptions = {
  objective: string
  searchQueries: string[]
  clientModel?: string
  sessionId?: string
  signal?: AbortSignal
}

export type WebSearchResult = {
  url: string
  title?: string
  publishDate?: string
  excerpts: string[]
}

export type WebSearchResponse = {
  searchId: string
  sessionId: string
  results: WebSearchResult[]
  warnings: string[]
}

export type WebReadOptions = {
  url: string
  objective?: string
  clientModel?: string
  sessionId?: string
  signal?: AbortSignal
}

export type WebReadResult = {
  url: string
  title?: string
  excerpts: string[]
  fullContent?: string
}

export type WebReadError = {
  url: string
  type: string
  status?: number
  content?: string
}

export type WebReadResponse = {
  extractId: string
  sessionId: string
  results: WebReadResult[]
  errors: WebReadError[]
  warnings: string[]
}
