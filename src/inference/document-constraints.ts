export const MAX_DOCUMENTS_PER_MESSAGE = 10
export const MAX_RAW_DOCUMENT_BYTES = 20 * 1024 * 1024
export const MAX_TOTAL_DOCUMENT_BYTES = 30 * 1024 * 1024
export const MAX_EXTRACTED_DOCUMENT_CHARS = 160_000
export const MAX_TOTAL_EXTRACTED_DOCUMENT_CHARS = 180_000
export const MAX_PDF_PAGES = 500

export const PDF_MIME_TYPE = "application/pdf"
export const DOCX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

export const SUPPORTED_DOCUMENT_EXTENSIONS = [
  ".txt",
  ".text",
  ".md",
  ".markdown",
  ".log",
  ".csv",
  ".tsv",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".html",
  ".htm",
  ".css",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hh",
  ".hpp",
  ".sh",
  ".zsh",
  ".fish",
  ".sql",
  ".ini",
  ".cfg",
  ".conf",
  ".env",
  ".pdf",
  ".docx",
] as const

const SUPPORTED_DOCUMENT_MIME_TYPES = [
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/tab-separated-values",
  "text/html",
  "text/css",
  "text/javascript",
  "application/json",
  "application/ld+json",
  "application/toml",
  "application/x-toml",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  PDF_MIME_TYPE,
  DOCX_MIME_TYPE,
] as const

export function normalizedDocumentMimeType(value: string | undefined) {
  const mimeType = value?.split(";", 1)[0]?.trim().toLowerCase()
  if (!mimeType || mimeType === "application/octet-stream") return undefined
  if (mimeType.startsWith("text/")) return mimeType
  return (SUPPORTED_DOCUMENT_MIME_TYPES as readonly string[]).includes(mimeType)
    ? mimeType
    : undefined
}

export function isSupportedDocumentMimeType(value: unknown): value is string {
  return typeof value === "string" && normalizedDocumentMimeType(value) === value
}
