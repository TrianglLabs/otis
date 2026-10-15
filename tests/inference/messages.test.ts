import { describe, expect, it } from "vitest"
import {
  displayUserMessage,
  formatSkillForModel,
  userMessageAttachments,
  userMessageText,
} from "../../src/inference/messages.js"
import type { AttachmentContentPart, SkillContentPart } from "../../src/inference/types.js"

const createSkillInvocation = (
  skill: SkillContentPart,
  attachments: readonly AttachmentContentPart[] = [],
) => ({ role: "user" as const, content: [...attachments, skill] })

describe("skill invocation messages", () => {
  const tdd = {
    type: "skill" as const,
    name: "tdd",
    arguments: "fix the lock",
    instructions: "Write a failing test for $ARGUMENTS first.",
  }

  it("shows the command as typed while the model reads the instructions with the arguments in place", () => {
    const message = createSkillInvocation(tdd)
    expect(message).toEqual({ role: "user", content: [tdd] })
    expect(userMessageText(message)).toBe("/tdd fix the lock")
    expect(displayUserMessage(message)).toBe("/tdd fix the lock")
    expect(userMessageAttachments(message)).toEqual([])
    expect(formatSkillForModel(tdd)).toBe(
      "The user ran the tdd skill. Follow its instructions for this request.\n\n" +
        "Write a failing test for fix the lock first.",
    )
  })

  it("appends arguments a skill has no placeholder for, and nothing when there are none", () => {
    expect(formatSkillForModel({ ...tdd, instructions: "Test first." })).toBe(
      "The user ran the tdd skill. Follow its instructions for this request.\n\nTest first.\n\nfix the lock",
    )
    expect(formatSkillForModel({ ...tdd, arguments: "", instructions: "Test first." })).toBe(
      "The user ran the tdd skill. Follow its instructions for this request.\n\nTest first.",
    )
    expect(userMessageText(createSkillInvocation({ ...tdd, arguments: "" }))).toBe("/tdd")
  })

  it("keeps attachments ahead of the invocation, as a plain prompt keeps them ahead of its text", () => {
    const image = {
      type: "image" as const,
      data: "aGk=",
      mimeType: "image/png" as const,
      name: "shot.png",
      sizeBytes: 2,
    }
    const message = createSkillInvocation(tdd, [image])
    expect(message.content).toEqual([image, tdd])
    expect(userMessageAttachments(message)).toEqual([image])
    expect(displayUserMessage(message)).toBe("/tdd fix the lock\n📎 shot.png")
  })
})
