import type { ToolCall } from "./types.js"

export const TOOL_ACTIVITY_KINDS = [
  "web_search",
  "web_read",
  "file_read",
  "file_search",
  "file_write",
  "file_edit",
  "file_inspect",
  "git",
  "shell",
  "agent",
] as const

export type ToolActivityKind = (typeof TOOL_ACTIVITY_KINDS)[number]

export type ToolActivity = {
  kind: ToolActivityKind
  label: string
}

export function describeToolCall(call: ToolCall): ToolActivity {
  if (call.name === "web_search")
    return { kind: "web_search", label: `Searching web: ${short(call.input.objective)}` }
  if (call.name === "web_read")
    return { kind: "web_read", label: `Reading web: ${short(call.input.url)}` }
  if (call.name === "skill")
    return { kind: "file_read", label: `Loading skill: ${short(call.input.skill)}` }
  if (call.name === "read")
    return { kind: "file_read", label: `Reading files: ${short(call.input.path)}` }
  if (call.name === "grep")
    return { kind: "file_search", label: `Searching files: ${short(call.input.pattern)}` }
  if (call.name === "glob")
    return { kind: "file_search", label: `Finding files: ${short(call.input.pattern)}` }
  if (call.name === "write")
    return { kind: "file_write", label: `Writing file: ${short(call.input.path)}` }
  if (call.name === "save_attachment")
    return { kind: "file_write", label: `Saving attachment: ${short(call.input.path)}` }
  if (call.name === "edit")
    return { kind: "file_edit", label: `Editing file: ${short(call.input.path)}` }
  if (call.name === "edit_document")
    return { kind: "file_edit", label: `Editing document: ${short(call.input.path)}` }
  if (call.name === "document") {
    const inspecting = call.input.operation === "check" || call.input.operation === "inspect-pdf"
    return {
      kind: inspecting ? "file_inspect" : "file_write",
      label: `Document: ${call.input.operation}${call.input.path ? ` · ${short(call.input.path)}` : ""}`,
    }
  }
  if (call.name === "publish_artifact")
    return { kind: "file_read", label: `Publishing artifact: ${short(call.input.path)}` }
  if (call.name === "agent")
    return { kind: "agent", label: `Delegating: ${short(call.input.description)}` }

  const command = call.input.command
  if (/\b(rg|grep|find)\b/.test(command))
    return { kind: "file_search", label: `Searching files: ${short(command)}` }
  if (/^\s*(ls|pwd|tree)\b/.test(command))
    return { kind: "file_inspect", label: `Inspecting files: ${short(command)}` }
  if (/^\s*git\b/.test(command)) return { kind: "git", label: `Inspecting git: ${short(command)}` }
  return { kind: "shell", label: `Running command: ${short(command)}` }
}

export function isToolActivityKind(value: unknown): value is ToolActivityKind {
  return typeof value === "string" && (TOOL_ACTIVITY_KINDS as readonly string[]).includes(value)
}

function short(text: string) {
  return text.length <= 96 ? text : `${text.slice(0, 93)}...`
}
