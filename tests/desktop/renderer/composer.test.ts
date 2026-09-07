import { describe, expect, it } from "vitest"
import { draftAfterSend } from "../../../src/desktop/renderer/features/conversation/draft.js"

describe("draftAfterSend", () => {
  it("clears the draft when the submitted text is still what's in the box", () => {
    expect(draftAfterSend("hello", "hello", true)).toBe("")
  })

  it("keeps edits made while the submission was in flight", () => {
    expect(draftAfterSend("hello, and one more thing", "hello", true)).toBe("hello, and one more thing")
    expect(draftAfterSend("something else entirely", "hello", true)).toBe("something else entirely")
  })

  it("always keeps the draft when the submission was rejected", () => {
    expect(draftAfterSend("hello", "hello", false)).toBe("hello")
  })
})
