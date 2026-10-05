import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import type { Routine } from "../../src/local/routines.js"
import { createPermissionPolicy } from "../../src/permissions/policy.js"
import { executeToolCall } from "../../src/tools/index.js"
import { parseStructuredToolCall } from "../../src/tools/schema.js"
import type { RoutineStore, ToolCall } from "../../src/tools/types.js"

const digest: Routine = {
  id: "r1",
  name: "Morning digest",
  prompt: "Summarize yesterday.",
  cwd: "/work/otis",
  schedule: { kind: "daily", time: "07:30" },
  auto: true,
  enabled: true,
  createdAt: "2026-10-05T07:00:00.000Z",
}

function fakeStore(routines: Routine[] = []) {
  const store: RoutineStore = {
    list: () => routines.map((routine) => ({ ...routine, nextRunAt: "2026-10-06T07:30:00.000Z" })),
    save: vi.fn(async (input) => {
      const existing = routines.find((routine) => routine.id === input.id)
      const saved: Routine = {
        ...(existing ?? { createdAt: "2026-10-05T08:00:00.000Z" }),
        ...input,
        id: existing?.id ?? "r_new",
      }
      if (existing) routines[routines.indexOf(existing)] = saved
      else routines.push(saved)
      return saved
    }),
    remove: vi.fn(async (id) => {
      routines.splice(
        routines.findIndex((routine) => routine.id === id),
        1,
      )
    }),
  }
  return store
}

const call = (input: Extract<ToolCall, { name: "routines" }>["input"]): ToolCall => ({
  name: "routines",
  input,
})

describe("routines tool", () => {
  it("parses each action and refuses a save without its fields", () => {
    expect(parseStructuredToolCall("routines", { action: "list" })).toEqual(
      call({ action: "list" }),
    )
    expect(
      parseStructuredToolCall("routines", {
        action: "save",
        name: "Nightly",
        prompt: "Run the suite.",
        schedule: { kind: "interval", minutes: 60 },
        enabled: false,
      }),
    ).toEqual(
      call({
        action: "save",
        name: "Nightly",
        prompt: "Run the suite.",
        schedule: { kind: "interval", minutes: 60 },
        enabled: false,
      }),
    )
    expect(() => parseStructuredToolCall("routines", { action: "save", name: "x" })).toThrow(
      'requires "name", "prompt", and a "schedule"',
    )
    expect(() => parseStructuredToolCall("routines", { action: "remove" })).toThrow('"id"')
    expect(() => parseStructuredToolCall("routines", { action: "pause" })).toThrow("action")
  })

  it("lists, saves in the working folder without granting tools, and removes", async () => {
    const store = fakeStore([digest])
    const context = { cwd: "/work/site", routines: store }
    const listed = (await executeToolCall(call({ action: "list" }), context)).output
    expect(listed).toContain("Morning digest (r1) · /work/otis · daily at 07:30 · next ")
    expect(listed).toContain("tools without asking: on")
    const saved = await executeToolCall(
      call({
        action: "save",
        name: "Nightly",
        prompt: "Run the suite.",
        cwd: "packages/app",
        schedule: { kind: "interval", minutes: 60 },
      }),
      context,
    )
    expect(store.save).toHaveBeenCalledExactlyOnceWith({
      name: "Nightly",
      prompt: "Run the suite.",
      cwd: join("/work/site", "packages/app"),
      schedule: { kind: "interval", minutes: 60 },
      model: undefined,
      auto: false,
      enabled: true,
    })
    expect(saved.title).toBe("Saved routine: Nightly")
    // Replacing a routine keeps the user's tools-without-asking choice.
    await executeToolCall(
      call({
        action: "save",
        id: "r1",
        name: "Morning digest",
        prompt: "Summarize yesterday in detail.",
        schedule: { kind: "daily", time: "08:00" },
      }),
      context,
    )
    expect(store.save).toHaveBeenLastCalledWith(expect.objectContaining({ id: "r1", auto: true }))
    expect((await executeToolCall(call({ action: "remove", id: "r1" }), context)).output).toContain(
      "Morning digest",
    )
    expect(store.remove).toHaveBeenCalledExactlyOnceWith("r1")
    await expect(
      executeToolCall(call({ action: "list" }), { cwd: "/work", routines: { error: "Bad file." } }),
    ).rejects.toThrow("Bad file.")
    await expect(executeToolCall(call({ action: "remove", id: "nope" }), context)).rejects.toThrow(
      "No routine nope.",
    )
  })

  it("asks before saving or removing even in auto mode, and is denied under dontAsk", async () => {
    const cwd = process.cwd()
    const auto = createPermissionPolicy({ cwd, mode: "auto" })
    const dontAsk = createPermissionPolicy({ cwd, mode: "dontAsk" })
    const save = call({
      action: "save",
      name: "Nightly",
      prompt: "x",
      schedule: { kind: "interval", minutes: 5 },
    })
    expect(await auto.evaluate(save)).toMatchObject({ effect: "ask", resources: ["Nightly"] })
    expect(await auto.evaluate(call({ action: "remove", id: "r1" }))).toMatchObject({
      effect: "ask",
      resources: ["r1"],
    })
    expect((await auto.evaluate(call({ action: "list" }))).effect).toBe("allow")
    expect((await dontAsk.evaluate(save)).effect).toBe("deny")
    expect((await dontAsk.evaluate(call({ action: "list" }))).effect).toBe("allow")
  })
})
