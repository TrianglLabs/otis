import { lstat } from "node:fs/promises"
import { extname, join } from "node:path"
import { workspaceArtifactReference } from "../artifacts/files.js"
import { runDocumentProcess } from "../documents/process.js"
import { checkDocumentRuntime, ensureDocumentRuntime } from "../documents/runtime.js"
import { bundledSkills, materializeBundledSkill } from "../skills/bundled.js"
import type { ToolCall, ToolContext, ToolResult } from "./types.js"
import { isNotFoundError, resolveWorkspacePath } from "./workspace.js"

export async function runDocumentWorkflow(
  input: Extract<ToolCall, { name: "document" }>["input"],
  context: ToolContext,
): Promise<ToolResult> {
  context.signal?.throwIfAborted()
  const options = { dataDirectory: context.dataDirectory, signal: context.signal }
  if (input.operation === "check") {
    return {
      title: "Check document capabilities",
      output: JSON.stringify(await checkDocumentRuntime(options)),
    }
  }
  const cwd = await resolveWorkspacePath(".", context)
  const args: string[] = [input.operation]
  if (input.path) {
    const path = await resolveWorkspacePath(input.path, context)
    const expected = input.operation === "convert" ? ".docx" : ".pdf"
    if (extname(path).toLowerCase() !== expected)
      throw new Error(`This document operation requires a ${expected} source.`)
    await boundedFile(path, 20 * 1024 * 1024)
    args.push("--source", path)
  }
  if (input.specPath) {
    const path = await resolveWorkspacePath(input.specPath, context)
    await boundedFile(path, 1024 * 1024)
    args.push("--spec", path)
  }
  let output: string | undefined
  if (input.outputPath) {
    output = await resolveWorkspacePath(input.outputPath, context, { allowMissingLeaf: true })
    const existing = await lstat(output).catch((error) => {
      if (!isNotFoundError(error)) throw error
    })
    if (existing) throw new Error("Document output already exists; choose a new path.")
    if (input.operation !== "render") {
      const allowed = input.operation === "create" ? [".pdf", ".docx"] : [".pdf"]
      if (!allowed.includes(extname(output).toLowerCase()))
        throw new Error("Unsupported document output format.")
    }
    args.push(input.operation === "render" ? "--output-dir" : "--output", output)
  }
  if (input.pages) args.push("--pages", input.pages.join(","))
  if (input.operation === "convert") {
    const status = await checkDocumentRuntime(options)
    if (!status.python) throw new Error(status.reason)
    if (!status.libreoffice)
      throw new Error("Word-to-PDF conversion requires a local LibreOffice installation.")
  }
  const skill = bundledSkills(context.dataDirectory).find((entry) => entry.name === "documents")
  if (!skill) throw new Error("Bundled documents skill is missing.")
  await materializeBundledSkill(skill)
  // This executable always uses first-party helpers, even when a project overrides the workflow
  // instructions.
  const python = await ensureDocumentRuntime(options, join(skill.root, "requirements.txt"))
  const result = JSON.parse(
    await runDocumentProcess(python, ["-E", "-s", "-B", join(skill.root, "document.py"), ...args], {
      cwd,
      signal: context.signal,
    }),
  ) as { ok?: boolean }
  if (result.ok !== true) throw new Error("Document helper did not verify a successful result.")
  const artifact =
    output && input.operation !== "render"
      ? await workspaceArtifactReference(output, cwd)
      : undefined
  return {
    title: `Document: ${input.operation}`,
    output: JSON.stringify(result),
    ...(artifact ? { artifact } : {}),
  }
}

async function boundedFile(path: string, maximum: number) {
  const info = await lstat(path)
  if (!info.isFile() || info.size === 0 || info.size > maximum)
    throw new Error("Document input must be a nonempty regular file within the size limit.")
}
