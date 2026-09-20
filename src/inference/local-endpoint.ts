import { isLoopbackHostname } from "./openai-compat.js"

/** Local servers, including PAIR proxies, share the same loopback ingress boundary. */
export function normalizeLocalBaseURL(value: string) {
  const input = value.trim()
  if (!input) throw new Error("Local model server endpoint is required.")
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    throw new Error("Local model server endpoint is invalid.")
  }
  if (parsed.protocol !== "http:" || !isLoopbackHostname(parsed.hostname)) {
    throw new Error("Local model server endpoint must use HTTP on 127.0.0.1, localhost, or ::1.")
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Local model server endpoint must not include credentials, query parameters, or a fragment.")
  }
  const path = parsed.pathname.replace(/\/+$/, "")
  if (path && path !== "/v1") {
    throw new Error("Local model server endpoint must be a base URL without an API path.")
  }
  parsed.pathname = "/"
  return parsed.toString().replace(/\/$/, "")
}
