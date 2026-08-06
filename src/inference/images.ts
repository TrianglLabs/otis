import { readFile, stat } from "node:fs/promises"
import { basename, extname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { ImageContentPart, ImageMimeType } from "./types.js"

export const MAX_IMAGES_PER_REQUEST = 30
export const MAX_BASE64_IMAGE_BYTES = 10_000_000
const MAX_RAW_IMAGE_BYTES = Math.floor(((MAX_BASE64_IMAGE_BYTES - 1) * 3) / 4)
const IMAGE_FILE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tif", ".tiff", ".ppm"])

export async function loadImageFile(path: string, cwd: string): Promise<ImageContentPart> {
  const absolutePath = resolve(cwd, path)
  const file = await stat(absolutePath)
  if (!file.isFile()) throw new Error(`Image path is not a file: ${path}`)
  if (file.size === 0) throw new Error(`Image file is empty: ${path}`)
  if (file.size > MAX_RAW_IMAGE_BYTES) {
    throw new Error(`Image exceeds the Fireworks base64 request limit: ${path}`)
  }
  return createImageAttachment(await readFile(absolutePath), basename(absolutePath))
}

export async function loadImageFiles(paths: readonly string[], cwd: string): Promise<ImageContentPart[]> {
  if (paths.length > MAX_IMAGES_PER_REQUEST) {
    throw new Error(`Fireworks accepts at most ${MAX_IMAGES_PER_REQUEST} images per request.`)
  }
  const images: ImageContentPart[] = []
  for (const path of paths) {
    images.push(await loadImageFile(path, cwd))
    validateImageAttachments(images)
  }
  return images
}

export function createImageAttachment(bytes: Uint8Array, name: string, declaredMimeType?: string): ImageContentPart {
  if (bytes.byteLength === 0) throw new Error("Image data is empty.")
  if (bytes.byteLength > MAX_RAW_IMAGE_BYTES) throw new Error("Image exceeds the Fireworks base64 request limit.")

  const mimeType = detectImageMimeType(bytes)
  if (!mimeType) throw new Error("Unsupported image format. Use PNG, JPEG, GIF, BMP, TIFF, or PPM.")
  if (declaredMimeType && normalizeMimeType(declaredMimeType) !== mimeType) {
    throw new Error(`Pasted image data does not match its declared MIME type (${declaredMimeType}).`)
  }

  return {
    type: "image",
    data: Buffer.from(bytes).toString("base64"),
    mimeType,
    name: attachmentName(name, mimeType),
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
  if ((ascii(bytes, 0, 2) === "P3" || ascii(bytes, 0, 2) === "P6") && isWhitespace(bytes[2])) {
    return "image/x-portable-pixmap"
  }
  return undefined
}

/** Parses the shell-escaped path text emitted when files are dropped into common macOS and Linux terminals. */
export function parsePastedImagePaths(value: string): string[] | undefined {
  const tokens = tokenizePastedPaths(value.trim())
  if (!tokens || tokens.length === 0) return undefined

  const paths = tokens.map(normalizePastedPath)
  if (paths.some((path) => !path || !IMAGE_FILE_EXTENSIONS.has(extname(path).toLowerCase()))) return undefined
  return paths
}

function tokenizePastedPaths(value: string): string[] | undefined {
  if (!value) return []
  const tokens: string[] = []
  let token = ""
  let quote: "single" | "double" | undefined
  let escaped = false

  for (const character of value) {
    if (escaped) {
      token += character
      escaped = false
      continue
    }
    if (character === "\\" && quote !== "single") {
      escaped = true
      continue
    }
    if (character === "'" && quote !== "double") {
      quote = quote === "single" ? undefined : "single"
      continue
    }
    if (character === '"' && quote !== "single") {
      quote = quote === "double" ? undefined : "double"
      continue
    }
    if (!quote && isShellWhitespace(character)) {
      if (token) tokens.push(token)
      token = ""
      continue
    }
    token += character
  }

  if (escaped || quote) return undefined
  if (token) tokens.push(token)
  return tokens
}

function isShellWhitespace(character: string) {
  return character === " " || character === "\t" || character === "\r" || character === "\n"
}

function normalizePastedPath(value: string) {
  if (!value.startsWith("file://")) return value
  try {
    return fileURLToPath(value)
  } catch {
    return ""
  }
}

function normalizeMimeType(value: string): ImageMimeType | undefined {
  const mimeType = value.split(";", 1)[0]?.trim().toLowerCase()
  if (mimeType === "image/jpg") return "image/jpeg"
  if (mimeType === "image/x-png") return "image/png"
  if (
    mimeType === "image/png" ||
    mimeType === "image/jpeg" ||
    mimeType === "image/gif" ||
    mimeType === "image/bmp" ||
    mimeType === "image/tiff" ||
    mimeType === "image/x-portable-pixmap"
  ) {
    return mimeType
  }
  return undefined
}

function extensionForMimeType(mimeType: ImageMimeType) {
  if (mimeType === "image/jpeg") return "jpg"
  if (mimeType === "image/x-portable-pixmap") return "ppm"
  return mimeType.slice("image/".length)
}

function attachmentName(name: string, mimeType: ImageMimeType) {
  const safeName = [...basename(name)]
    .map((character) => (isControlCharacter(character) ? " " : character))
    .join("")
    .trim()
  return safeName || `image.${extensionForMimeType(mimeType)}`
}

function isControlCharacter(character: string) {
  const codePoint = character.codePointAt(0) ?? 0
  return codePoint <= 0x1f || codePoint === 0x7f
}

function startsWith(bytes: Uint8Array, signature: readonly number[]) {
  return signature.every((byte, index) => bytes[index] === byte)
}

function ascii(bytes: Uint8Array, start: number, length: number) {
  return String.fromCharCode(...bytes.slice(start, start + length))
}

function isWhitespace(byte: number | undefined) {
  return byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x20
}
