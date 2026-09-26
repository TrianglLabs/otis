import type { DocumentOperation, ToolCall } from "./types.js"

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

/**
 * Each action's activity kind, the verb of its one-line label, and the verb a card shows while
 * the action runs and once it is done. The desktop localizes the last two; the terminal uses them.
 */
export const TOOL_ACTIONS = {
  web_search: ["web_search", "Searching web", "Searching the web for", "Searched the web for"],
  web_read: ["web_read", "Reading web", "Reading", "Read"],
  skill: ["file_read", "Loading skill", "Loading skill", "Loaded skill"],
  read: ["file_read", "Reading files", "Reading", "Read"],
  grep: ["file_search", "Searching files", "Searching files for", "Searched files for"],
  glob: ["file_search", "Finding files", "Finding files", "Found files"],
  write: ["file_write", "Writing file", "Writing", "Wrote"],
  save_attachment: ["file_write", "Saving attachment", "Saving", "Saved"],
  edit: ["file_edit", "Editing file", "Editing", "Edited"],
  edit_document: ["file_edit", "Editing document", "Editing document", "Edited document"],
  document_check: ["file_inspect", "Checking document", "Checking document", "Checked document"],
  document_inspect_pdf: ["file_inspect", "Inspecting PDF", "Inspecting PDF", "Inspected PDF"],
  document_create: ["file_write", "Creating document", "Creating document", "Created document"],
  document_edit_pdf: ["file_edit", "Editing PDF", "Editing PDF", "Edited PDF"],
  document_convert: [
    "file_write",
    "Converting document",
    "Converting document",
    "Converted document",
  ],
  document_render: ["file_write", "Rendering document", "Rendering document", "Rendered document"],
  publish_artifact: ["file_read", "Publishing artifact", "Publishing", "Published"],
  agent: ["agent", "Delegating", "Delegating", "Delegated"],
  search_command: ["file_search", "Searching files", "Searching files", "Searched files"],
  inspect_command: ["file_inspect", "Inspecting files", "Inspecting files", "Inspected files"],
  git_command: ["git", "Inspecting git", "Checking git", "Checked git"],
  command: ["shell", "Running command", "Running", "Ran"],
} as const satisfies Record<string, readonly [ToolActivityKind, string, string, string]>

export type ToolAction = keyof typeof TOOL_ACTIONS

const DOCUMENT_ACTIONS: Record<DocumentOperation, ToolAction> = {
  check: "document_check",
  "inspect-pdf": "document_inspect_pdf",
  create: "document_create",
  "edit-pdf": "document_edit_pdf",
  convert: "document_convert",
  render: "document_render",
}

export type ToolActivity = {
  kind: ToolActivityKind
  action: ToolAction
  /** What the action applies to: a path, pattern, URL, command, or description, untrimmed. */
  subject: string
  /** One line for surfaces without structure: the terminal, headless output, permission prompts. */
  label: string
}

export function describeToolAction(action: ToolAction, subject: string): ToolActivity {
  const [kind, verb] = TOOL_ACTIONS[action]
  return { kind, action, subject, label: `${verb}: ${short(subject)}` }
}

export function describeToolCall(call: ToolCall): ToolActivity {
  if (call.name === "web_search") return describeToolAction("web_search", call.input.objective)
  if (call.name === "web_read") return describeToolAction("web_read", call.input.url)
  if (call.name === "skill") return describeToolAction("skill", call.input.skill)
  if (call.name === "read") return describeToolAction("read", call.input.path)
  if (call.name === "grep") return describeToolAction("grep", call.input.pattern)
  if (call.name === "glob") return describeToolAction("glob", call.input.pattern)
  if (call.name === "write") return describeToolAction("write", call.input.path)
  if (call.name === "save_attachment") return describeToolAction("save_attachment", call.input.path)
  if (call.name === "edit") return describeToolAction("edit", call.input.path)
  if (call.name === "edit_document") return describeToolAction("edit_document", call.input.path)
  if (call.name === "document") {
    const { operation, path, outputPath, specPath } = call.input
    return describeToolAction(DOCUMENT_ACTIONS[operation], path ?? outputPath ?? specPath ?? "")
  }
  if (call.name === "publish_artifact")
    return describeToolAction("publish_artifact", call.input.path)
  if (call.name === "agent") return describeToolAction("agent", call.input.description)

  const command = call.input.command
  if (/\b(rg|grep|find)\b/.test(command)) return describeToolAction("search_command", command)
  if (/^\s*(ls|pwd|tree)\b/.test(command)) return describeToolAction("inspect_command", command)
  if (/^\s*git\b/.test(command)) return describeToolAction("git_command", command)
  return describeToolAction("command", command)
}

/** Actions whose subject is a path, so a card can lead with the file name. */
const PATH_ACTIONS = new Set<ToolAction>([
  "read",
  "write",
  "edit",
  "edit_document",
  "save_attachment",
  "publish_artifact",
  "document_check",
  "document_inspect_pdf",
  "document_create",
  "document_edit_pdf",
  "document_convert",
  "document_render",
])

/** A subject as a card shows it: the file name and its folder for a single path, else whole. */
export function splitSubject(action: ToolAction, subject: string): [name: string, folder?: string] {
  const slash = PATH_ACTIONS.has(action) && !subject.includes(", ") ? subject.lastIndexOf("/") : -1
  return slash === -1 ? [subject] : [subject.slice(slash + 1), subject.slice(0, slash)]
}

export function isToolActivityKind(value: unknown): value is ToolActivityKind {
  return typeof value === "string" && (TOOL_ACTIVITY_KINDS as readonly string[]).includes(value)
}

export function isToolAction(value: unknown): value is ToolAction {
  return typeof value === "string" && Object.hasOwn(TOOL_ACTIONS, value)
}

function short(text: string) {
  return text.length <= 96 ? text : `${text.slice(0, 93)}...`
}
