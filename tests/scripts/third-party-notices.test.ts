import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

describe("third-party notices", () => {
  it("pins the audited Mermaid Tiny bundle and its embedded component notices", async () => {
    const [bundle, notices, packageText] = await Promise.all([
      readFile("node_modules/@mermaid-js/tiny/dist/mermaid.tiny.js"),
      readFile("THIRD_PARTY_NOTICES.md", "utf8"),
      readFile("node_modules/@mermaid-js/tiny/package.json", "utf8"),
    ])
    const mermaidPackage = JSON.parse(packageText) as { version: string }
    const digest = createHash("sha256").update(bundle).digest("hex")

    expect(notices).toContain(`@mermaid-js/tiny@${mermaidPackage.version}`)
    expect(notices).toContain(digest)
    expect(notices).toContain("`chevrotain@11.1.2`")
    expect(notices).toContain("`d3-selection@3.0.0`")
    expect(notices).toContain("`dompurify@3.4.12`")
  })
})
