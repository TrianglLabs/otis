import type { Skill } from "../skills/index.js"
import promptText from "./system-prompt.txt" with { type: "text" }
import type { ContextFile, ToolDefinition } from "./types.js"

const MAX_CONTEXT_FILES = 10
const MAX_CONTEXT_FILE_BYTES = 32 * 1024
const MAX_CONTEXT_TOTAL_BYTES = 64 * 1024

const BASE_PROMPT = promptText.trim()

/** Included only when the agent tool is offered, so models without delegation are never told to delegate. */
const DELEGATION_GUIDANCE = [
  "Delegation:",
  "- Use agent for read-only exploration or research whose tool output would otherwise flood this conversation, such as mapping an unfamiliar codebase or comparing several sources. Do not delegate narrow lookups you can answer with one or two tool calls, and do not delegate edits or commands.",
  "- A subagent cannot see this conversation. Give it a complete brief and state exactly what to report back. To explore independent areas at once, make several agent calls in the same response with non-overlapping scopes; they run in parallel.",
].join("\n")

export function buildSystemPrompt(
  projectContext: readonly ContextFile[] = [],
  now = new Date(),
  skills: readonly Skill[] = [],
  tools: readonly ToolDefinition[] = [],
) {
  const sections = [BASE_PROMPT]
  if (tools.some((tool) => tool.name === "agent")) sections.push(DELEGATION_GUIDANCE)
  if (projectContext.length > 0) sections.push(formatProjectContext(projectContext))
  if (skills.length > 0) sections.push(formatAvailableSkills(skills))
  sections.push(`The current date is ${formatDate(now)}. Use this date when searching for recent information.`)
  return sections.join("\n\n")
}

function formatAvailableSkills(skills: readonly Skill[]) {
  const entries = skills.map(
    (skill) => `  <skill name="${escapeAttribute(skill.name)}">${escapeText(skill.description)}</skill>`,
  )
  return `<available_skills>\nSkills provide specialized workflows. When a task matches a skill below, call the skill tool to load its SKILL.md before proceeding. Load referenced resources only when needed.\n${entries.join("\n")}\n</available_skills>`
}

function formatProjectContext(files: readonly ContextFile[]) {
  if (files.length > MAX_CONTEXT_FILES) {
    throw new Error(`Project context must not exceed ${MAX_CONTEXT_FILES} files.`)
  }

  let totalBytes = 0
  const formatted = files.map((file, index) => {
    const path = file.path.trim()
    if (!path) throw new Error(`Project context file ${index + 1} is missing a path.`)
    if (path.length > 1024) throw new Error(`Project context path ${index + 1} is too long.`)

    const content = truncateUtf8(file.content, MAX_CONTEXT_FILE_BYTES)
    totalBytes += Buffer.byteLength(content)
    if (totalBytes > MAX_CONTEXT_TOTAL_BYTES) {
      throw new Error(`Project context must not exceed ${MAX_CONTEXT_TOTAL_BYTES} bytes.`)
    }

    return `<file path="${escapeAttribute(path)}">\n${content}\n</file>`
  })

  return `<project_context>\nProject-specific instructions and guidelines:\n\n${formatted.join("\n\n")}\n</project_context>`
}

function truncateUtf8(content: string, maximumBytes: number) {
  const encoded = Buffer.from(content)
  if (encoded.byteLength <= maximumBytes) return content

  let end = maximumBytes
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1
  return `${encoded.subarray(0, end).toString("utf8")}\n\n[File truncated at ${maximumBytes} bytes.]`
}

function escapeAttribute(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

function escapeText(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

function formatDate(value: Date) {
  if (!Number.isFinite(value.getTime())) throw new Error("Current date is invalid.")
  return value.toISOString().slice(0, 10)
}
