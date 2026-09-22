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

// Vision billing by 512px tiles after fitting the image into 2048x2048 and its short side to
// 768px: 85 tokens plus 170 per tile, so between 255 and 1,445 tokens.
const IMAGE_BASE_TOKENS = 85
const IMAGE_TILE_TOKENS = 170
const IMAGE_TILE_SIDE = 512
const IMAGE_MAX_LONG_SIDE = 2_048
const IMAGE_MAX_SHORT_SIDE = 768

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

export function estimateImageTokens(
  image: Pick<ImageContentPart, "data" | "mimeType" | "sizeBytes">,
): number {
  // Without a readable header, assume a square: uncompressed formats hold three bytes per pixel
  // and compressed ones about a quarter of a byte.
  const fallbackSide = Math.sqrt(
    image.sizeBytes /
      (image.mimeType === "image/tiff" || image.mimeType === "image/x-portable-pixmap" ? 3 : 0.25),
  )
  const [width, height] = imageDimensions(image) ?? [fallbackSide, fallbackSide]
  const scale = Math.min(1, IMAGE_MAX_LONG_SIDE / Math.max(width, height))
  const shortScale = Math.min(1, IMAGE_MAX_SHORT_SIDE / (Math.min(width, height) * scale))
  const tiles = (side: number) =>
    Math.max(1, Math.ceil((side * scale * shortScale) / IMAGE_TILE_SIDE))
  return IMAGE_BASE_TOKENS + IMAGE_TILE_TOKENS * tiles(width) * tiles(height)
}

/** Pixel size from a PNG, GIF, BMP, or JPEG header, decoding only the base64 it needs. */
function imageDimensions({ data, mimeType }: Pick<ImageContentPart, "data" | "mimeType">) {
  const bytes = (offset: number, length: number) => {
    const first = Math.floor(offset / 3)
    const chunk = Buffer.from(data.slice(first * 4, Math.ceil((offset + length) / 3) * 4), "base64")
    const slice = chunk.subarray(offset - first * 3, offset - first * 3 + length)
    return slice.length === length ? slice : undefined
  }
  const dimensions = (width: number, height: number): [number, number] | undefined =>
    width > 0 && height > 0 ? [width, height] : undefined
  if (mimeType === "image/png") {
    const header = bytes(16, 8)
    return header && dimensions(header.readUInt32BE(0), header.readUInt32BE(4))
  }
  if (mimeType === "image/gif") {
    const header = bytes(6, 4)
    return header && dimensions(header.readUInt16LE(0), header.readUInt16LE(2))
  }
  if (mimeType === "image/bmp") {
    const header = bytes(18, 8)
    return header && dimensions(Math.abs(header.readInt32LE(0)), Math.abs(header.readInt32LE(4)))
  }
  if (mimeType !== "image/jpeg") return undefined
  // Walk the segments to the first start-of-frame marker (SOF0 to SOF15 except DHT, JPG, DAC),
  // whose payload is precision, height, then width.
  let offset = 2
  for (let segment = bytes(offset, 9); segment; segment = bytes(offset, 9)) {
    if (segment[0] !== 0xff) return undefined
    const marker = segment[1]
    if (marker === 0xff) offset += 1
    else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      return dimensions(segment.readUInt16BE(7), segment.readUInt16BE(5))
    else if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) offset += 2
    else offset += 2 + segment.readUInt16BE(2)
  }
  return undefined
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
