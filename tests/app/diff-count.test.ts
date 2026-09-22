import { createPatch } from "diff"
import { describe, expect, it } from "vitest"
import { countDiffLines } from "../../src/app/transcript.js"

const PATCH_OPTIONS = {
  context: 3,
  headerOptions: { includeIndex: false, includeUnderline: false, includeFileHeaders: true },
}

function count(before: string, after: string) {
  return countDiffLines(createPatch("file.md", before, after, "", "", PATCH_OPTIONS))
}

describe("countDiffLines", () => {
  it.each([
    ["one changed line", "a\nb\n", "a\nc\n", { added: 1, removed: 1 }],
    ["a new file", "", "one\ntwo\nthree\n", { added: 3, removed: 0 }],
    ["an emptied file", "one\ntwo\n", "", { added: 0, removed: 2 }],
    ["a removed Markdown rule", "x\n---\ny\n", "x\ny\n", { added: 0, removed: 1 }],
    ["an added Markdown rule", "x\ny\n", "x\n---\ny\n", { added: 1, removed: 0 }],
    ["a rule replaced by a longer one", "a\n---\nb\n", "a\n----\nb\n", { added: 1, removed: 1 }],
    ["a line beginning with plus signs", "x\n", "x\n+++ heading\n", { added: 1, removed: 0 }],
    [
      "front matter fences",
      "---\ntitle: a\n---\n",
      "---\ntitle: b\n---\n",
      { added: 1, removed: 1 },
    ],
    ["a change without trailing newlines", "a\nb", "a\nc", { added: 1, removed: 1 }],
    ["only a trailing newline added", "a\nb", "a\nb\n", { added: 0, removed: 0 }],
    ["only a trailing newline removed", "a\nb\n", "a\nb", { added: 0, removed: 0 }],
    ["a last line changed and newline added", "a\nb", "a\nc\n", { added: 1, removed: 1 }],
    ["CRLF content", "a\r\nb\r\n", "a\r\nc\r\n", { added: 1, removed: 1 }],
  ])("counts %s", (_name, before, after, expected) => {
    expect(count(before, after)).toEqual(expected)
  })

  it("ignores everything before the first hunk", () => {
    const diff = "--- a\n+++ b\n-not a hunk\n+not a hunk\n@@ -1 +1 @@\n-old\n+new\n"
    expect(countDiffLines(diff)).toEqual({ added: 1, removed: 1 })
  })

  it("counts an empty or headerless string as no change", () => {
    expect(countDiffLines("")).toEqual({ added: 0, removed: 0 })
    expect(countDiffLines("just text\n+plus\n")).toEqual({ added: 0, removed: 0 })
  })
})
