import type { Skill } from "../skills/index.js"
import promptText from "./system-prompt.txt" with { type: "text" }
import type { ContextFile, OutputCapabilities, ToolDefinition } from "./types.js"

const MAX_CONTEXT_FILES = 10
const MAX_CONTEXT_FILE_BYTES = 32 * 1024
const MAX_CONTEXT_TOTAL_BYTES = 64 * 1024

const BASE_PROMPT = promptText.trim()

/** Included only when the agent tool is offered, so models without delegation are never told to delegate. */
const DELEGATION_GUIDANCE = [
  "Delegation:",
  "- Use agent for read-only exploration or research whose tool output would otherwise flood this conversation, such as mapping an unfamiliar codebase or comparing several sources. Do not delegate narrow lookups you can answer with one or two tool calls, and do not delegate edits or commands.",
  "- A subagent cannot see this conversation. Give it a complete brief and state exactly what to report back. To explore independent areas at once, make several agent calls in the same response with non-overlapping scopes; they run in parallel.",
  '- In Otis, subagents are called "coworkers": delegated agent runs appear to the user as coworkers in the app. Use the word coworkers when referring to subagents, and mention what each coworker is doing in plain language.',
].join("\n")

const MERMAID_GUIDANCE = [
  "Canvas:",
  "- Canvas is for rendered documents and visual outputs. Plain code, configuration, and raw text stay in the conversation. Do not rename or wrap code as Markdown or HTML just to open it in Canvas.",
  "- This interface lets the user open fenced Mermaid diagrams in a visual Canvas.",
  "- When brainstorming or completing new, complex functionality, use a ```mermaid fenced block when it materially clarifies architecture, state, or information flow.",
  "- Choose the diagram type that best matches the information; use sequenceDiagram only for time-ordered interactions.",
  "- Canvas does not support Mermaid mindmap or architecture diagrams; use another supported diagram type instead.",
  "- Keep the surrounding explanation self-contained. Do not use click directives, HTML labels, or external resources.",
].join("\n")

const NO_MERMAID_GUIDANCE = "- Avoid mermaid diagrams; this interface cannot render them."

export function buildSystemPrompt(
  projectContext: readonly ContextFile[] = [],
  now = new Date(),
  skills: readonly Skill[] = [],
  tools: readonly ToolDefinition[] = [],
  outputCapabilities: OutputCapabilities = {},
) {
  const sections = [BASE_PROMPT]
  if (
    tools.some((tool) => tool.name === "edit_document" || tool.name === "document" || tool.name === "save_attachment")
  ) {
    sections.push(
      [
        "Document work:",
        "- When asked to edit or adapt an uploaded file, preserve its file type unless the user requests a different deliverable. Do not silently substitute Markdown or plain text for PDF, Word, or images.",
        "- Preserve existing formatting and design by default. A request to update content is not permission to redesign or rebuild the document. Work from the original file using supported edits.",
        "- Attachments contain extracted text for reasoning; their names are not workspace paths and their page layout is not shown to you.",
        tools.some((tool) => tool.name === "save_attachment")
          ? "- Use save_attachment to obtain original bytes in a new workspace file when local processing is needed."
          : "- Attachment export is unavailable in this tool selection; do not invent source paths or extract private session files.",
        tools.some((tool) => tool.name === "document")
          ? "- For PDF or Word creation, conversion, or substantial rewriting, load the documents skill when available. Use the document tool; it prepares and reuses its private dependencies automatically. Its check operation reports readiness without installing. If required software is missing or the task is unsupported, explain the specific limitation and ask about an alternative; do not claim completion."
          : "- The document creation, conversion and PDF text-editing tool is unavailable in this tool selection; explain that limitation if the task requires it.",
        tools.some((tool) => tool.name === "edit_document")
          ? "- Use edit_document for supported DOCX text replacements and interactive PDF forms. Ordinary PDF text cannot be rewritten by that tool."
          : "- The native document editor is unavailable in this tool selection.",
        tools.some((tool) => tool.name === "document")
          ? "- For existing PDF page text, load the documents skill and use the document tool's inspect-pdf/edit-pdf operations. It edits original text objects, retains their fonts and positions, rejects overflow, and compares rendered pages outside the edited text. Try this supported path before proposing recreation; follow its explicit limitations."
          : "- Do not bypass a disabled document tool by running its helpers through the shell.",
        "- If the requested edit cannot preserve the existing design with available tools, explain the limitation and request an editable source or agreement to a new layout before recreating the document. An explicit request or prior agreement to redesign already authorizes that change; do not ask again. Recreating PDF or DOCX from extracted text does not preserve its original design.",
        "- DOCX edits retain document structure and existing formatting, but changed text can reflow lines and pages. Do not promise identical pagination or visual fidelity without checking the rendered result.",
        "- For text and code use read/edit/write. Image input supports analysis; modification requires an available image tool or local image workflow. Never claim an image was edited just because it was described.",
        "- Verify the actual saved deliverable, its content, and requested format before publication. Distinguish structural/text checks from visual layout inspection; Canvas preview alone is not evidence that you inspected the pages.",
      ].join("\n"),
    )
  }
  if (tools.some((tool) => tool.name === "agent")) sections.push(DELEGATION_GUIDANCE)
  if (tools.some((tool) => tool.name === "publish_artifact")) {
    sections.push(
      [
        "File deliverables:",
        "- File tools operate inside the workspace. Do not use bash to bypass a file-tool path restriction; request the appropriate workspace or permission instead.",
        "- When delivering a Markdown, text, HTML, PDF, or Word file, call publish_artifact on its final path after generation, verification, edits, and moves. Shell commands and links in your reply do not publish artifacts.",
        "- Publication saves a private preview revision. Keep the returned artifact_id and pass it when publishing later edits or moves of the same deliverable; omit it only for a new artifact. Working-file previews remain live and can become unavailable if moved or deleted.",
        "- Only publish files the user asked you to create, edit, or present, not unrelated files you inspected. External publication requires permission and does not grant edit access.",
      ].join("\n"),
    )
  }
  sections.push(outputCapabilities.mermaid ? MERMAID_GUIDANCE : NO_MERMAID_GUIDANCE)
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
