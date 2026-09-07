import { createPatch } from "diff"
import { describe, expect, it } from "vitest"
import { parseDiffDisplay } from "../../../src/desktop/renderer/features/conversation/diff.js"

const LEGACY_DIFF = `Index: /Users/dev/project/src/app.ts
===================================================================
--- /Users/dev/project/src/app.ts
+++ /Users/dev/project/src/app.ts
@@ -44,3 +44,3 @@
 const a = 1
-const b = 2
+const b = 3
 const c = 4`

const MULTI_HUNK = `--- src/app.ts
+++ src/app.ts
@@ -10,2 +10,2 @@
-oldTen
+newTen
 contextTen
@@ -40,2 +41,3 @@
 contextForty
-oldForty
+newForty
+addedFortyOne`

describe("parseDiffDisplay", () => {
  it("strips patch scaffolding and numbers lines from the hunk header", () => {
    expect(parseDiffDisplay(LEGACY_DIFF)).toEqual([
      { kind: "context", text: "const a = 1", oldLine: 44, newLine: 44 },
      { kind: "remove", text: "const b = 2", oldLine: 45 },
      { kind: "add", text: "const b = 3", newLine: 45 },
      { kind: "context", text: "const c = 4", oldLine: 46, newLine: 46 },
    ])
  })

  it("tracks old and new numbers independently across hunks, separated by a gap row", () => {
    expect(parseDiffDisplay(MULTI_HUNK)).toEqual([
      { kind: "remove", text: "oldTen", oldLine: 10 },
      { kind: "add", text: "newTen", newLine: 10 },
      { kind: "context", text: "contextTen", oldLine: 11, newLine: 11 },
      { kind: "gap" },
      { kind: "context", text: "contextForty", oldLine: 40, newLine: 41 },
      { kind: "remove", text: "oldForty", oldLine: 41 },
      { kind: "add", text: "newForty", newLine: 42 },
      { kind: "add", text: "addedFortyOne", newLine: 43 },
    ])
  })
})

it("preserves removed lines that resemble patch file headers", () => {
  // A removed SQL comment (`-- x`) produces the diff line `--- x`, identical to a file header.
  const patch = createPatch("query.sql", "-- old comment\nSELECT 1;\n", "SELECT 1;\n")
  expect(parseDiffDisplay(patch)).toEqual([
    { kind: "remove", text: "-- old comment", oldLine: 1 },
    { kind: "context", text: "SELECT 1;", oldLine: 2, newLine: 1 },
  ])
})

it("preserves added lines that resemble patch file headers", () => {
  const patch = createPatch("counter.ts", "", "++count;\n")
  expect(parseDiffDisplay(patch)).toEqual([{ kind: "add", text: "++count;", newLine: 1 }])
})
