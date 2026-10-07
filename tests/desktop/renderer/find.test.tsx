// @vitest-environment happy-dom

import { expect, it } from "vitest"
import { matchOffsets, textRanges } from "../../../src/desktop/renderer/features/canvas/find.js"

it("finds every case-insensitive occurrence, including overlapping ones", () => {
  expect(matchOffsets("Otis otis OTIS", "otis")).toEqual([0, 5, 10])
  expect(matchOffsets("aaaa", "aa")).toEqual([0, 1, 2])
  expect(matchOffsets("anything", "")).toEqual([])
})

it("ranges over visible text in document order and skips scripts, styles, and hidden nodes", () => {
  document.body.innerHTML =
    "<article><p>First <b>note</b> here.</p><script>note()</script><style>.note{}</style>" +
    "<p hidden>hidden note</p><p>Last note.</p></article>"
  const ranges = textRanges(document.body, "note")
  expect(ranges.map((range) => range.startContainer.parentElement?.tagName)).toEqual(["B", "P"])
  expect(ranges.map((range) => range.toString())).toEqual(["note", "note"])
})
