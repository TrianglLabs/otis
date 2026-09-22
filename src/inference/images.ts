import { readFile, stat } from "node:fs/promises"
import { basename, extname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  type ImageContentPart,
  type ImageMimeType,
  MAX_BASE64_IMAGE_BYTES,
  MAX_IMAGES_PER_REQUEST,
  MAX_RAW_IMAGE_BYTES,
} from "./types.js"

export async function loadImageFiles(
  paths: readonly string[],
  cwd: string,
): Promise<ImageContentPart[]> {
  if (paths.length > MAX_IMAGES_PER_REQUEST) {
    throw new Error(`Fireworks accepts at most ${MAX_IMAGES_PER_REQUEST} images per request.`)
  }
  const images: ImageContentPart[] = []
  for (const path of paths) {
    const absolutePath = resolve(cwd, path)
    const file = await stat(absolutePath)
    if (!file.isFile()) throw new Error(`Image path is not a file: ${path}`)
    if (file.size === 0) throw new Error(`Image file is empty: ${path}`)
    if (file.size > MAX_RAW_IMAGE_BYTES) {
      throw new Error(`Image exceeds the Fireworks base64 request limit: ${path}`)
    }
    images.push(createImageAttachment(await readFile(absolutePath), basename(absolutePath)))
    validateImageAttachments(images)
  }
  return images
}

export function createImageAttachment(
  bytes: Uint8Array,
  name: string,
  declaredMimeType?: string,
): ImageContentPart {
  if (bytes.byteLength === 0) throw new Error("Image data is empty.")
  if (bytes.byteLength > MAX_RAW_IMAGE_BYTES)
    throw new Error("Image exceeds the Fireworks base64 request limit.")

  const mimeType = detectImageMimeType(bytes)
  if (!mimeType) throw new Error("Unsupported image format. Use PNG, JPEG, GIF, BMP, TIFF, or PPM.")
  if (declaredMimeType) {
    const declared = declaredMimeType.split(";", 1)[0]?.trim().toLowerCase()
    const normalized =
      declared === "image/jpg" ? "image/jpeg" : declared === "image/x-png" ? "image/png" : declared
    if (normalized !== mimeType) {
      throw new Error(
        `Pasted image data does not match its declared MIME type (${declaredMimeType}).`,
      )
    }
  }
  return {
    type: "image",
    data: Buffer.from(bytes).toString("base64"),
    mimeType,
    name: safeAttachmentName(name, `image.${extensionForMimeType(mimeType)}`),
    sizeBytes: bytes.byteLength,
  }
}

export function createPastedImageAttachment(
  bytes: Uint8Array,
  sequence: number,
  declaredMimeType?: string,
): ImageContentPart {
  const image = createImageAttachment(bytes, "", declaredMimeType)
  return { ...image, name: `pasted-image-${sequence}.${extensionForMimeType(image.mimeType)}` }
}

export function validateImageAttachments(images: readonly ImageContentPart[]) {
  if (images.length > MAX_IMAGES_PER_REQUEST) {
    throw new Error(`Fireworks accepts at most ${MAX_IMAGES_PER_REQUEST} images per request.`)
  }
  const base64Bytes = images.reduce((total, image) => total + image.data.length, 0)
  if (base64Bytes >= MAX_BASE64_IMAGE_BYTES) {
    throw new Error("Total image data must be under the Fireworks 10 MB base64 request limit.")
  }
}

export function detectImageMimeType(bytes: Uint8Array): ImageMimeType | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return "image/gif"
  if (ascii(bytes, 0, 2) === "BM") return "image/bmp"
  if (
    startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) ||
    startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a]) ||
    startsWith(bytes, [0x49, 0x49, 0x2b, 0x00]) ||
    startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2b])
  ) {
    return "image/tiff"
  }
  if (
    (ascii(bytes, 0, 2) === "P3" || ascii(bytes, 0, 2) === "P6") &&
    [0x09, 0x0a, 0x0d, 0x20].includes(bytes[2])
  ) {
    return "image/x-portable-pixmap"
  }
  return undefined
}

/**
 * Strips directories and control characters so the name is safe to show and to send as
 * metadata.
 */
export function safeAttachmentName(name: string, fallback: string) {
  const safe = [...basename(name)]
    .map((character) =>
      (character.codePointAt(0) ?? 0) <= 0x1f || character === "" ? " " : character,
    )
    .join("")
    .trim()
  return safe || fallback
}

function extensionForMimeType(mimeType: ImageMimeType) {
  if (mimeType === "image/jpeg") return "jpg"
  if (mimeType === "image/x-portable-pixmap") return "ppm"
  return mimeType.slice("image/".length)
}

function startsWith(bytes: Uint8Array, signature: readonly number[]) {
  return signature.every((byte, index) => bytes[index] === byte)
}

function ascii(bytes: Uint8Array, start: number, length: number) {
  return String.fromCharCode(...bytes.slice(start, start + length))
}

/**
 * Parses shell-escaped paths emitted when files are dropped into common macOS and Linux
 * terminals.
 */
export function parsePastedFilePaths(
  value: string,
  allowedExtensions: ReadonlySet<string>,
): string[] | undefined {
  const tokens: string[] = []
  let token = ""
  let quote: "'" | '"' | undefined
  let escaped = false
  for (const character of value.trim()) {
    if (escaped) {
      token += character
      escaped = false
    } else if (character === "\\" && quote !== "'") {
      escaped = true
    } else if (character === "'" && quote !== '"') {
      quote = quote ? undefined : "'"
    } else if (character === '"' && quote !== "'") {
      quote = quote ? undefined : '"'
    } else if (!quote && " \t\r\n".includes(character)) {
      if (token) tokens.push(token)
      token = ""
    } else {
      token += character
    }
  }
  if (escaped || quote) return undefined
  if (token) tokens.push(token)
  if (tokens.length === 0) return undefined

  const paths = tokens.map((token) => {
    if (!token.startsWith("file://")) return token
    try {
      return fileURLToPath(token)
    } catch {
      return ""
    }
  })
  if (paths.some((path) => !path || !allowedExtensions.has(extname(path).toLowerCase())))
    return undefined
  return paths
}
