import { executeLocalTool } from "./local.js"
import type { ToolCall, ToolContext, ToolResult } from "./types.js"
import { executeWebTool } from "./web.js"

export {
  describeToolCall,
  isToolActivityKind,
  TOOL_ACTIVITY_KINDS,
  type ToolActivity,
  type ToolActivityKind,
} from "./activity.js"
export { parseSerializedToolCall, parseStructuredToolCall, TOOL_DEFINITIONS, type ToolDefinition } from "./schema.js"
export type { ToolCall, ToolContext, ToolName, ToolResult } from "./types.js"
export { TOOL_NAMES } from "./types.js"

export async function executeToolCall(call: ToolCall, context: ToolContext = {}): Promise<ToolResult> {
  if (call.name === "web_search" || call.name === "web_read") return executeWebTool(call, context)
  return executeLocalTool(call, context)
}
