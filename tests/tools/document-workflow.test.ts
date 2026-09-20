import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createPermissionPolicy } from "../../src/permissions/policy.js"
import * as bundled from "../../src/skills/bundled.js"
import { executeToolCall } from "../../src/tools/index.js"
import { parseStructuredToolCall } from "../../src/tools/schema.js"

const mocks = vi.hoisted(() => ({ ensure: vi.fn(), check: vi.fn(), run: vi.fn() }))
vi.mock("../../src/documents/runtime.js", () => ({
  ensureDocumentRuntime: mocks.ensure,
  checkDocumentRuntime: mocks.check,
}))
vi.mock("../../src/documents/process.js", () => ({ runDocumentProcess: mocks.run }))
const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.resetAllMocks()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "otis-document-tool-")))
  directories.push(root)
  const cwd = join(root, "workspace")
  await mkdir(cwd)
  await writeFile(join(cwd, "plan.json"), "{}")
  await writeFile(join(cwd, "source.pdf"), "fixture PDF")
  mocks.ensure.mockResolvedValue("/private/document runtime/bin/python")
  mocks.check.mockResolvedValue({ ready: false, python: null })
  mocks.run.mockImplementation(async (_command: string, args: string[]) => {
    const output = args[args.indexOf("--output") + 1]
    if (args.includes("--output")) await writeFile(output, "fixture document")
    return JSON.stringify({ ok: true, path: output })
  })
  return { cwd, dataDirectory: join(root, "data") }
}

const call = (input: Record<string, unknown>) => parseStructuredToolCall("document", input)

describe("document tool", () => {
  it("selects the documents bundle by name, runs its helper and returns a Canvas reference", async () => {
    const context = await setup()
    const skills = bundled.bundledSkills(context.dataDirectory)
    vi.spyOn(bundled, "bundledSkills").mockReturnValueOnce([
      { ...skills[0], name: "unrelated", root: join(context.dataDirectory, "unrelated") },
      ...skills,
    ])
    const result = await executeToolCall(
      call({ operation: "create", spec_path: "plan.json", output_path: "resume final.pdf" }),
      context,
    )
    expect(mocks.ensure).toHaveBeenCalledOnce()
    expect(mocks.run.mock.calls[0][0]).toBe("/private/document runtime/bin/python")
    expect(mocks.run.mock.calls[0][1]).toEqual([
      "-E",
      "-s",
      "-B",
      expect.stringMatching(/bundled-skills.*document\.py$/),
      "create",
      "--spec",
      join(context.cwd, "plan.json"),
      "--output",
      join(context.cwd, "resume final.pdf"),
    ])
    expect(result.artifact).toEqual({ source: "workspace", path: "resume final.pdf", kind: "pdf" })
    await expect(
      executeToolCall(call({ operation: "create", spec_path: "plan.json", output_path: "resume final.pdf" }), context),
    ).rejects.toThrow("already exists")
    expect(mocks.ensure).toHaveBeenCalledOnce()
  })

  it("checks capabilities without installing or executing a helper", async () => {
    const context = await setup()
    expect(JSON.parse((await executeToolCall(call({ operation: "check" }), context)).output)).toEqual({
      ready: false,
      python: null,
    })
    expect(mocks.ensure).not.toHaveBeenCalled()
    expect(mocks.run).not.toHaveBeenCalled()
    expect(await readdir(context.cwd)).toEqual(["plan.json", "source.pdf"])
  })

  it("reports missing LibreOffice before installing packages for conversion", async () => {
    const context = await setup()
    await writeFile(join(context.cwd, "source.docx"), "fixture Word")
    mocks.check.mockResolvedValue({ ready: false, python: "/test/python3", libreoffice: false })
    await expect(
      executeToolCall(call({ operation: "convert", path: "source.docx", output_path: "converted.pdf" }), context),
    ).rejects.toThrow("LibreOffice")
    expect(mocks.ensure).not.toHaveBeenCalled()
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it("rejects source and output path escapes, including symlinks, before setup", async () => {
    const context = await setup()
    await symlink(context.dataDirectory, join(context.cwd, "outside"))
    await mkdir(context.dataDirectory)
    for (const input of [
      { operation: "create", spec_path: "plan.json", output_path: "../outside.pdf" },
      { operation: "create", spec_path: "plan.json", output_path: "outside/out.pdf" },
      { operation: "inspect-pdf", path: "../source.pdf" },
      { operation: "create", spec_path: "plan.json", output_path: "out.md" },
    ])
      await expect(executeToolCall(call(input), context)).rejects.toThrow()
    expect(mocks.ensure).not.toHaveBeenCalled()
    expect(await readdir(context.dataDirectory)).toEqual([])
  })

  it("passes page selection and rejects a helper failure without reporting success", async () => {
    const context = await setup()
    await executeToolCall(call({ operation: "inspect-pdf", path: "source.pdf", pages: [1, 3] }), context)
    expect(mocks.run.mock.calls[0][1]).toEqual(expect.arrayContaining(["inspect-pdf", "--pages", "1,3"]))
    mocks.run.mockRejectedValue(new Error("Text exceeds original space"))
    await expect(
      executeToolCall(
        call({ operation: "edit-pdf", path: "source.pdf", spec_path: "plan.json", output_path: "edited.pdf" }),
        context,
      ),
    ).rejects.toThrow("original space")
    expect(await readdir(context.cwd)).toEqual(["plan.json", "source.pdf"])
  })

  it("checks every document path against policy and restricts preparation under non-auto modes", async () => {
    const context = await setup()
    const edit = call({ operation: "edit-pdf", path: "source.pdf", spec_path: "plan.json", output_path: "edited.pdf" })
    const ask = createPermissionPolicy({ cwd: context.cwd, mode: "ask" })
    expect(await ask.evaluate(edit)).toMatchObject({
      effect: "ask",
      resources: ["source.pdf", "plan.json", "edited.pdf"],
    })
    expect((await ask.evaluate(call({ operation: "check" }))).effect).toBe("allow")
    const dontAsk = createPermissionPolicy({ cwd: context.cwd, mode: "dontAsk" })
    expect((await dontAsk.evaluate(edit)).effect).toBe("deny")
    const deny = createPermissionPolicy({
      cwd: context.cwd,
      mode: "auto",
      rules: [{ tool: "document", resource: "plan.json", effect: "deny" }],
    })
    expect((await deny.evaluate(edit)).effect).toBe("deny")
  })

  it("validates operation-specific inputs without accepting arbitrary commands", () => {
    expect(call({ operation: "inspect-pdf", path: " source.pdf ", pages: [2] })).toEqual({
      name: "document",
      input: { operation: "inspect-pdf", path: "source.pdf", pages: [2] },
    })
    for (const input of [
      {},
      { operation: "install" },
      { operation: "check", command: "pip install anything" },
      { operation: "create", output_path: "out.pdf" },
      { operation: "convert", path: "in.docx" },
      { operation: "inspect-pdf", path: "in.pdf", pages: [1, 1] },
      { operation: "inspect-pdf", path: "in.pdf", pages: [0] },
      { operation: "inspect-pdf", path: "in.pdf", pages: [true] },
      { operation: "check", pages: [1] },
    ])
      expect(() => call(input)).toThrow()
  })
})
