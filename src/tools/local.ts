import { publishArtifact } from "./artifacts.js"
import { editLocalDocument } from "./documents.js"
import { editLocalFile, readLocalFile, writeLocalFile } from "./files.js"
import { globLocalFiles, grepLocalFiles } from "./search.js"
import { runBash } from "./shell.js"
import type { ToolCall, ToolContext, ToolResult } from "./types.js"

type LocalToolCall = Extract<
  ToolCall,
  { name: "read" | "grep" | "glob" | "write" | "edit" | "edit_document" | "publish_artifact" | "bash" }
>

export function executeLocalTool(call: LocalToolCall, context: ToolContext): Promise<ToolResult> {
  switch (call.name) {
    case "read":
      return readLocalFile(call.input.path, call.input.offset, call.input.limit, context)
    case "grep":
      return grepLocalFiles(call.input.pattern, call.input.path, call.input.include, call.input.maxResults, context)
    case "glob":
      return globLocalFiles(call.input.pattern, call.input.path, call.input.maxResults, context)
    case "write":
      return writeLocalFile(call.input.path, call.input.content, context)
    case "edit":
      return editLocalFile(call.input.path, call.input.old, call.input.new, context)
    case "edit_document":
      return editLocalDocument(call.input, context)
    case "bash":
      return runBash(call.input.command, call.input.timeoutMs, context)
    case "publish_artifact":
      return publishArtifact(call.input.path, call.input.artifactId, context)
  }
}
