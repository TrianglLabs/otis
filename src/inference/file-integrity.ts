import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"

export async function sha256File(path: string) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}

export function normalizedSha256(value: string) {
  const digest = value.toLowerCase().replace(/^sha256:/, "")
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Expected a valid SHA-256 digest.")
  return digest
}
