import type { SkillCatalog } from "../skills/index.js"
import type { ParallelClient } from "../web/client.js"

export const TOOL_NAMES = [
  "web_search",
  "web_read",
  "skill",
  "read",
  "grep",
  "glob",
  "write",
  "edit",
  "bash",
  "agent",
] as const

export type ToolName = (typeof TOOL_NAMES)[number]

export type ToolCall =
  | {
      name: "web_search"
      input: { objective: string; searchQueries: string[] }
    }
  | {
      name: "web_read"
      input: { url: string; objective?: string }
    }
  | {
      name: "skill"
      input: { skill: string; path?: string }
    }
  | {
      name: "read"
      input: { path: string; offset?: number; limit?: number }
    }
  | {
      name: "grep"
      input: { pattern: string; path: string; include?: string; maxResults?: number }
    }
  | {
      name: "glob"
      input: { pattern: string; path: string; maxResults?: number }
    }
  | {
      name: "write"
      input: { path: string; content: string }
    }
  | {
      name: "edit"
      input: { path: string; old: string; new: string }
    }
  | {
      name: "bash"
      input: { command: string; timeoutMs?: number }
    }
  | {
      name: "agent"
      input: { description: string; prompt: string }
    }

export type ToolResult = {
  title: string
  output: string
  diff?: string
}

export type WebToolSession = { id?: string }

export type ToolContext = {
  cwd?: string
  signal?: AbortSignal
  webClient?: ParallelClient
  webClientModel?: string
  webSession?: WebToolSession
  skills?: SkillCatalog
}
