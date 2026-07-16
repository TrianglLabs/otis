import type { WebReadResponse, WebSearchResponse } from "../web/types.js"
import type { ToolCall, ToolContext, ToolResult } from "./types.js"

type WebToolCall = Extract<ToolCall, { name: "web_search" | "web_read" }>

export async function executeWebTool(call: WebToolCall, context: ToolContext): Promise<ToolResult> {
  if (!context.webClient) throw new Error("Parallel API key is not configured.")

  if (call.name === "web_search") {
    const response = await context.webClient.search({
      objective: call.input.objective,
      searchQueries: call.input.searchQueries,
      clientModel: context.webClientModel,
      sessionId: context.webSession?.id,
      signal: context.signal,
    })
    if (context.webSession) context.webSession.id = response.sessionId
    return {
      title: call.input.objective,
      output: formatSearchResults(response),
    }
  }

  const response = await context.webClient.read({
    url: call.input.url,
    objective: call.input.objective,
    clientModel: context.webClientModel,
    sessionId: context.webSession?.id,
    signal: context.signal,
  })
  if (context.webSession) context.webSession.id = response.sessionId
  return {
    title: call.input.url,
    output: formatReadResults(response),
  }
}

function formatSearchResults(response: WebSearchResponse) {
  const sections = response.results.map((result, index) => {
    const heading = `${index + 1}. ${result.title ?? result.url}`
    const metadata = [result.url, result.publishDate].filter(Boolean).join(" · ")
    return [heading, metadata, ...result.excerpts].filter(Boolean).join("\n")
  })
  if (sections.length === 0) sections.push("No search results found.")
  appendWarnings(sections, response.warnings)
  return sections.join("\n\n")
}

function formatReadResults(response: WebReadResponse) {
  const sections = response.results.map((result) => {
    const content = result.fullContent ?? result.excerpts.join("\n")
    return [`# ${result.title ?? result.url}`, result.url, content || "No extractable content found."].join("\n\n")
  })
  for (const error of response.errors) {
    const status = error.status ? ` (HTTP ${error.status})` : ""
    sections.push(`Could not read ${error.url}: ${error.type}${status}${error.content ? `\n${error.content}` : ""}`)
  }
  if (sections.length === 0) sections.push("No extractable content found.")
  appendWarnings(sections, response.warnings)
  return sections.join("\n\n")
}

function appendWarnings(sections: string[], warnings: string[]) {
  if (warnings.length > 0) sections.push(`Warnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`)
}
