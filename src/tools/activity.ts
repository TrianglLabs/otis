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
] as const

export type ToolActivityKind = (typeof TOOL_ACTIVITY_KINDS)[number]

export type ToolActivity = {
  kind: ToolActivityKind
  label: string
}

export function describeToolCall(call: ToolCall) {
  if (call.name === "web_search") return activity("web_search", `Searching web: ${shortToolText(call.input.objective)}`)
  if (call.name === "web_read") return activity("web_read", `Reading web: ${shortToolText(call.input.url)}`)
  if (call.name === "skill") return activity("file_read", `Loading skill: ${shortToolText(call.input.skill)}`)
  if (call.name === "read") return activity("file_read", `Reading files: ${shortToolText(call.input.path)}`)
  if (call.name === "grep") return activity("file_search", `Searching files: ${shortToolText(call.input.pattern)}`)
  if (call.name === "glob") return activity("file_search", `Finding files: ${shortToolText(call.input.pattern)}`)
  if (call.name === "write") return activity("file_write", `Writing file: ${shortToolText(call.input.path)}`)
  if (call.name === "edit") return activity("file_edit", `Editing file: ${shortToolText(call.input.path)}`)

  const command = call.input.command
  if (/\b(rg|grep|find)\b/.test(command)) return activity("file_search", `Searching files: ${shortToolText(command)}`)
  if (/^\s*(ls|pwd|tree)\b/.test(command))
    return activity("file_inspect", `Inspecting files: ${shortToolText(command)}`)
  if (/^\s*git\b/.test(command)) return activity("git", `Inspecting git: ${shortToolText(command)}`)
  return activity("shell", `Running command: ${shortToolText(command)}`)
}

export function isToolActivityKind(value: unknown): value is ToolActivityKind {
  return typeof value === "string" && (TOOL_ACTIVITY_KINDS as readonly string[]).includes(value)
}

function activity(kind: ToolActivityKind, label: string): ToolActivity {
  return { kind, label }
}

function shortToolText(text: string, maxLength = 96) {
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength - 3)}...`
}
