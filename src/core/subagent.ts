import { lastAssistantText } from "../inference/messages.js"
import type { ChatMessage, ModelProvider } from "../inference/types.js"
import { TOOL_DEFINITIONS, type ToolCall, type ToolDefinition, type ToolName, type ToolResult } from "../tools/index.js"
import type { RunAgentOptions } from "./agent.js"

export type SubagentCall = Extract<ToolCall, { name: "agent" }>

/** Bounds a delegated run when the parent has no step limit of its own. */
export const SUBAGENT_MAX_STEPS = 50

/** Subagents explore and research only; they never mutate the workspace, run commands, or delegate again. */
const SUBAGENT_TOOLS: ReadonlySet<ToolName> = new Set(["read", "grep", "glob", "web_search", "web_read", "skill"])

/**
 * Delegation issues several long model runs at once. Otis' managed llama-server serves a single slot, so only hosted
 * Fireworks models and NVIDIA PAIR clusters offer the agent tool.
 */
export function supportsDelegation(provider: ModelProvider) {
  return provider !== "local"
}

/** The tool catalog a top-level turn exposes for the selected model's provider. */
export function providerTools(provider: ModelProvider): ToolDefinition[] {
  return TOOL_DEFINITIONS.filter((tool) => tool.name !== "agent" || supportsDelegation(provider))
}

export function subagentTools(tools: readonly ToolDefinition[]): ToolDefinition[] {
  return tools.filter((tool) => SUBAGENT_TOOLS.has(tool.name))
}

/**
 * Derives the child's run options from the parent's resolved options. The child shares the parent's client,
 * workspace, permission policy, approval handler, usage sink, and abort signal, but starts with a fresh history,
 * receives no steering, and works from the read-only subset of the parent's tools.
 */
export function subagentRunOptions(parent: RunAgentOptions): RunAgentOptions {
  return {
    ...parent,
    tools: subagentTools(parent.tools ?? []),
    maxSteps: parent.maxSteps ?? SUBAGENT_MAX_STEPS,
    steering: undefined,
    onCompaction: undefined,
  }
}

export function subagentBrief(call: SubagentCall): string {
  return [
    "You are an Otis subagent. The main agent delegated the task below and cannot see your work, only your final reply.",
    "You have no access to the main conversation; rely on this brief and your tools.",
    "Your tools are read-only. Do not attempt to modify files or run commands.",
    "When finished, reply with a concise report the main agent can act on directly: concrete findings, exact file paths and line references where relevant, and anything you could not verify. Do not ask questions.",
    "",
    "Task:",
    call.input.prompt,
  ].join("\n")
}

export function subagentResult(call: SubagentCall, messages: readonly ChatMessage[]): ToolResult {
  return { title: call.input.description, output: lastAssistantText(messages) }
}
