import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { documentExcerpt } from "../../src/artifacts/preview.js"
import { ArtifactPublisher } from "../../src/artifacts/publisher.js"

const directories: string[] = []
afterEach(() =>
  Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true }))),
)

describe("document previews", () => {
  it("sets an opening as plain lines, dropping markup and Markdown syntax", () => {
    expect(documentExcerpt("text", "# Plan\n\n- **Ship** it\n- `Test` it\n\n1. Then rest")).toBe(
      "Plan\nShip it\nTest it\nThen rest",
    )
    expect(
      documentExcerpt(
        "html",
        "<html><head><style>p{}</style><title>x</title></head><body><h1>Hi &amp; bye</h1><p>One</p><table><tr><td>Two</td><td>three</td></tr></table></body></html>",
      ),
    ).toBe("Hi & bye\nOne\nTwo three")
    expect(documentExcerpt("text", "x".repeat(1000))).toHaveLength(400)
  })

  it("keeps a published document's opening on its reference", async () => {
    const directory = await mkdtemp(join(tmpdir(), "otis-preview-"))
    directories.push(directory)
    const publisher = new ArtifactPublisher(directory)
    const notes = await publisher.publish(Buffer.from("# Notes\n\nFirst *point*.\n"), {
      name: "notes.md",
      kind: "markdown",
      path: join(directory, "notes.md"),
    })
    const page = await publisher.publish(Buffer.from("<h1>Title</h1><p>Body</p>"), {
      name: "page.html",
      kind: "html",
      path: join(directory, "page.html"),
    })
    expect(notes.excerpt).toBe("Notes\nFirst point.")
    expect(page.excerpt).toBe("Title\nBody")
  })
})
