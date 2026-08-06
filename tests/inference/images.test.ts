import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  createImageAttachment,
  loadImageFile,
  MAX_IMAGES_PER_REQUEST,
  parsePastedImagePaths,
  validateImageAttachments,
} from "../../src/inference/images.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("image attachments", () => {
  it("detects supported formats from file contents rather than extensions", async () => {
    const directory = await temporaryDirectory()
    await writeFile(join(directory, "screenshot.bin"), pngBytes())

    await expect(loadImageFile("screenshot.bin", directory)).resolves.toEqual({
      type: "image",
      data: Buffer.from(pngBytes()).toString("base64"),
      mimeType: "image/png",
      name: "screenshot.bin",
      sizeBytes: pngBytes().byteLength,
    })
  })

  it("rejects unsupported data and mismatched paste metadata", () => {
    expect(() => createImageAttachment(new Uint8Array([1, 2, 3]), "bad.bin")).toThrow("Unsupported image format")
    expect(() => createImageAttachment(pngBytes(), "image.png", "image/jpeg")).toThrow(
      "does not match its declared MIME type",
    )
  })

  it("enforces the provider image-count limit across a turn", () => {
    const image = createImageAttachment(pngBytes(), "image.png")
    expect(() => validateImageAttachments(Array.from({ length: MAX_IMAGES_PER_REQUEST + 1 }, () => image))).toThrow(
      `at most ${MAX_IMAGES_PER_REQUEST} images`,
    )
  })

  it("parses shell-escaped, quoted, and file-URL paths produced by terminal drag and drop", () => {
    expect(parsePastedImagePaths("/Users/me/Desktop/Screenshot\\ 2026-07-31\\ at\\ 9.22.10 PM.png ")).toEqual([
      "/Users/me/Desktop/Screenshot 2026-07-31 at 9.22.10 PM.png",
    ])
    expect(parsePastedImagePaths("'/tmp/first image.jpg' \"/tmp/second image.PNG\"")).toEqual([
      "/tmp/first image.jpg",
      "/tmp/second image.PNG",
    ])
    expect(parsePastedImagePaths("file:///tmp/a%20picture.gif")).toEqual(["/tmp/a picture.gif"])
  })

  it("does not claim regular pasted text or malformed shell quoting", () => {
    expect(parsePastedImagePaths("What does screenshot.png contain?")).toBeUndefined()
    expect(parsePastedImagePaths("'/tmp/unfinished.png")).toBeUndefined()
    expect(parsePastedImagePaths("/tmp/notes.txt")).toBeUndefined()
  })
})

function pngBytes() {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
}

async function temporaryDirectory() {
  const path = await mkdtemp(join(tmpdir(), "otis-images-"))
  temporaryDirectories.push(path)
  return path
}
