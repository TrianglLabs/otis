import { describe, expect, it } from "vitest"
import { formatWorkspaceLabel } from "../../src/app/workspace-label.js"

describe("workspace label", () => {
  it("abbreviates paths inside the home directory", () => {
    expect(formatWorkspaceLabel("/Users/test", "/Users/test")).toBe("~")
    expect(formatWorkspaceLabel("/Users/test/work/otis", "/Users/test")).toBe("~/work/otis")
  })

  it("compacts deep paths while preserving the current directory and its parent", () => {
    expect(formatWorkspaceLabel("/Users/test/code/clients/triangl/otis", "/Users/test")).toBe("~/…/triangl/otis")
    expect(formatWorkspaceLabel("/opt/company/projects/otis", "/Users/test")).toBe("/…/projects/otis")
  })

  it("does not treat a sibling path as part of the home directory", () => {
    expect(formatWorkspaceLabel("/Users/test-other/work/otis", "/Users/test")).toBe("/…/work/otis")
  })
})
