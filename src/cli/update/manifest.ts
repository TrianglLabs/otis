export type ReleaseArtifact = {
  path: string
  sha256: string
  size?: number
}

export type ReleaseManifest = {
  version: string
  artifacts: Record<string, ReleaseArtifact>
}

export async function fetchReleaseManifest(url: string, fetchImpl: typeof fetch, signal?: AbortSignal) {
  const response = await fetchImpl(url, signal ? { signal } : undefined)
  if (!response.ok) throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`)
  return parseReleaseManifest(await response.json())
}

export function resolveArtifactURL(baseURL: string, artifact: ReleaseArtifact) {
  const base = new URL(`${baseURL}/`)
  const resolved = resolveArtifactPath(base, artifact)
  if (!isURLWithinBase(resolved, base)) {
    throw new Error(`Release artifact URL must stay under ${base.toString()}`)
  }
  return resolved.toString()
}

export function normalizeBaseURL(value: string) {
  const trimmed = value.trim().replace(/\/+$/, "")
  if (!trimmed) throw new Error("Download base URL cannot be blank.")
  return trimmed
}

function parseReleaseManifest(value: unknown): ReleaseManifest {
  if (!isRecord(value)) throw new Error("Release manifest is invalid.")
  if (typeof value.version !== "string" || !value.version.trim()) {
    throw new Error("Release manifest is missing a version.")
  }
  if (!isRecord(value.artifacts)) throw new Error("Release manifest is missing artifacts.")

  const artifacts: Record<string, ReleaseArtifact> = {}
  for (const [target, valueArtifact] of Object.entries(value.artifacts)) {
    if (!isRecord(valueArtifact)) throw new Error(`Release artifact for ${target} is invalid.`)
    const path = nonEmptyString(valueArtifact.path)
    const sha256 = nonEmptyString(valueArtifact.sha256)
    const size = positiveInteger(valueArtifact.size)
    if (!path) throw new Error(`Release artifact for ${target} is missing a path.`)
    if (!sha256) throw new Error(`Release artifact for ${target} is missing a checksum.`)
    if (!/^[a-f\d]{64}$/i.test(sha256)) throw new Error(`Release artifact for ${target} has an invalid checksum.`)
    if (valueArtifact.size !== undefined && size === undefined) {
      throw new Error(`Release artifact for ${target} has an invalid size.`)
    }
    artifacts[target] = { path, sha256, size }
  }

  return { version: value.version, artifacts }
}

function resolveArtifactPath(base: URL, artifact: ReleaseArtifact) {
  if (artifact.path.startsWith("//") || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(artifact.path)) {
    throw new Error("Release artifact path must be relative.")
  }
  return new URL(artifact.path.replace(/^\/+/, ""), base)
}

function isURLWithinBase(url: URL, base: URL) {
  return url.protocol === base.protocol && url.host === base.host && url.pathname.startsWith(base.pathname)
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
