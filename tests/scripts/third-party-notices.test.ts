import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

describe("third-party notices", () => {
  it("pins the audited Pele bundle embedded in the Canvas frame", async () => {
    const [bundle, notices, packageText] = await Promise.all([
      readFile("node_modules/pele/dist/pele.global.js"),
      readFile("THIRD_PARTY_NOTICES.md", "utf8"),
      readFile("node_modules/pele/package.json", "utf8"),
    ])
    const pelePackage = JSON.parse(packageText) as { version: string }
    const digest = createHash("sha256").update(bundle).digest("hex")

    expect(notices).toContain(`pele@${pelePackage.version}`)
    expect(notices).toContain(digest)
  })
})
