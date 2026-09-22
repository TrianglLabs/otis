import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { parsePastedAttachmentPaths } from "../../src/inference/attachments.js"
import {
  createImageAttachment,
  estimateImageTokens,
  loadImageFiles,
  validateImageAttachments,
} from "../../src/inference/images.js"
import { type ImageMimeType, MAX_IMAGES_PER_REQUEST } from "../../src/inference/types.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe("image attachments", () => {
  it("detects supported formats from file contents rather than extensions", async () => {
    const directory = await temporaryDirectory()
    await writeFile(join(directory, "screenshot.bin"), pngBytes())

    await expect(loadImageFiles(["screenshot.bin"], directory)).resolves.toEqual([
      {
        type: "image",
        data: Buffer.from(pngBytes()).toString("base64"),
        mimeType: "image/png",
        name: "screenshot.bin",
        sizeBytes: pngBytes().byteLength,
      },
    ])
  })

  it("rejects missing, empty, and non-file image paths", async () => {
    const directory = await temporaryDirectory()
    await writeFile(join(directory, "empty.png"), new Uint8Array())
    await expect(loadImageFiles(["empty.png"], directory)).rejects.toThrow("is empty")
    await expect(loadImageFiles(["."], directory)).rejects.toThrow("not a file")
    await expect(loadImageFiles(["missing.png"], directory)).rejects.toThrow()
  })

  it("rejects unsupported data and mismatched paste metadata", () => {
    expect(() => createImageAttachment(new Uint8Array([1, 2, 3]), "bad.bin")).toThrow(
      "Unsupported image format",
    )
    expect(() => createImageAttachment(pngBytes(), "image.png", "image/jpeg")).toThrow(
      "does not match its declared MIME type",
    )
  })

  it("enforces the provider image-count limit across a turn", () => {
    const image = createImageAttachment(pngBytes(), "image.png")
    expect(() =>
      validateImageAttachments(Array.from({ length: MAX_IMAGES_PER_REQUEST + 1 }, () => image)),
    ).toThrow(`at most ${MAX_IMAGES_PER_REQUEST} images`)
  })

  it("parses shell-escaped, quoted, and file-URL paths produced by terminal drag and drop", () => {
    expect(
      parsePastedAttachmentPaths(
        "/Users/me/Desktop/Screenshot\\ 2026-07-31\\ at\\ 9.22.10 PM.png ",
      ),
    ).toEqual(["/Users/me/Desktop/Screenshot 2026-07-31 at 9.22.10 PM.png"])
    expect(parsePastedAttachmentPaths("'/tmp/first image.jpg' \"/tmp/second image.PNG\"")).toEqual([
      "/tmp/first image.jpg",
      "/tmp/second image.PNG",
    ])
    expect(parsePastedAttachmentPaths("file:///tmp/a%20picture.gif")).toEqual([
      "/tmp/a picture.gif",
    ])
  })

  it("does not claim regular pasted text or malformed shell quoting", () => {
    expect(parsePastedAttachmentPaths("What does screenshot.png contain?")).toBeUndefined()
    expect(parsePastedAttachmentPaths("'/tmp/unfinished.png")).toBeUndefined()
    expect(parsePastedAttachmentPaths("/tmp/archive.zip")).toBeUndefined()
  })
})

describe("image token estimate", () => {
  const image = (bytes: Uint8Array, mimeType: ImageMimeType, sizeBytes = bytes.byteLength) => ({
    data: Buffer.from(bytes).toString("base64"),
    mimeType,
    sizeBytes,
  })
  const tokens = (tiles: number) => 85 + 170 * tiles

  it.each([
    [1, 1, 1],
    [512, 512, 1],
    [513, 512, 2],
    [1024, 1024, 4],
    // 1920x1080 scales its short side to 768, leaving 1365x768.
    [1920, 1080, 3 * 2],
    // The long side shrinks to 2048 first, then the short side to 768: 2048x1536 -> 1024x768.
    [4096, 3072, 2 * 2],
    // A panorama keeps its 2048 long side once the short side is under 768.
    [8192, 512, 4 * 1],
    [768, 8192, 1 * 4],
  ])("bills a %dx%d PNG by 512px tiles after scaling (%d tiles)", (width, height, tiles) => {
    expect(estimateImageTokens(image(pngHeader(width, height), "image/png"))).toBe(tokens(tiles))
  })

  it("reads JPEG, GIF, and BMP headers", () => {
    expect(estimateImageTokens(image(jpegHeader(1600, 1200), "image/jpeg"))).toBe(tokens(2 * 2))
    expect(estimateImageTokens(image(gifHeader(640, 480), "image/gif"))).toBe(tokens(2 * 1))
    expect(estimateImageTokens(image(bmpHeader(300, -1100), "image/bmp"))).toBe(tokens(1 * 3))
  })

  it("falls back to a size-based square when the header is unreadable", () => {
    // 262,144 bytes of a compressed format read as about a megapixel: 1024x1024, four tiles.
    const truncated = image(new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg", 262_144)
    expect(estimateImageTokens(truncated)).toBe(tokens(4))
    const zero = image(pngHeader(0, 0), "image/png", 262_144)
    expect(estimateImageTokens(zero)).toBe(tokens(4))
    // Uncompressed formats hold three bytes per pixel: 480x480 is one tile.
    expect(estimateImageTokens(image(new Uint8Array(0), "image/tiff", 480 * 480 * 3))).toBe(
      tokens(1),
    )
    // Anything in the 10 MB request limit stays inside the 768px short-side cap.
    expect(estimateImageTokens(image(new Uint8Array(0), "image/jpeg", 7_000_000))).toBe(tokens(4))
  })
})

function pngHeader(width: number, height: number) {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(bytes.buffer).setUint32(16, width)
  new DataView(bytes.buffer).setUint32(20, height)
  return bytes
}

/** SOI, an APP0 segment, a padding APP1 segment, then SOF0 with height before width. */
function jpegHeader(width: number, height: number) {
  const app1 = new Uint8Array(3_000)
  const bytes = new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x10,
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    0x01,
    0x01,
    0x00,
    0,
    1,
    0,
    1,
    0,
    0,
    0xff,
    0xe1,
    (app1.length + 2) >> 8,
    (app1.length + 2) & 0xff,
    ...app1,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    3,
  ])
  return bytes
}

function gifHeader(width: number, height: number) {
  return new Uint8Array([
    0x47,
    0x49,
    0x46,
    0x38,
    0x39,
    0x61,
    width & 0xff,
    width >> 8,
    height & 0xff,
    height >> 8,
    0,
    0,
    0,
  ])
}

/** A bottom-up BMP stores a negative height. */
function bmpHeader(width: number, height: number) {
  const bytes = new Uint8Array(26)
  bytes.set([0x42, 0x4d])
  new DataView(bytes.buffer).setInt32(18, width, true)
  new DataView(bytes.buffer).setInt32(22, height, true)
  return bytes
}

function pngBytes() {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
}

async function temporaryDirectory() {
  const path = await mkdtemp(join(tmpdir(), "otis-images-"))
  temporaryDirectories.push(path)
  return path
}
