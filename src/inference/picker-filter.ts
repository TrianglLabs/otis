/** Picker search, kept free of Node modules so the desktop renderer can import it. */

import type { ModelPickerHeader, ModelPickerItem } from "./picker-catalog.js"
import { HOSTED_PROVIDER_INFO, isServerProvider, type ModelProvider, SERVER_INFO } from "./types.js"

/** How a hidden model is recorded in settings: its provider and catalog id. */
export function hiddenModelKey(provider: ModelProvider, id: string) {
  return `${provider}:${id}`
}

/** What a picker row's provider is called, for search and labels. */
export function providerLabel(provider: ModelProvider) {
  if (provider === "local") return "Local"
  if (provider === "pair") return "NVIDIA PAIR"
  if (isServerProvider(provider)) return SERVER_INFO[provider].name
  return HOSTED_PROVIDER_INFO[provider].name
}

/**
 * The rows whose name, id, or provider contains `query` (case-insensitive), each under its
 * section header; headers without a match are dropped.
 */
export function filterModelPickerItems(
  items: readonly ModelPickerItem[],
  query: string,
): ModelPickerItem[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...items]
  const result: ModelPickerItem[] = []
  let header: ModelPickerHeader | undefined
  for (const item of items) {
    if (item.kind === "header") {
      header = item
      continue
    }
    const haystack = `${item.displayName} ${item.id} ${providerLabel(item.provider)}`
    if (!haystack.toLowerCase().includes(needle)) continue
    if (header) result.push(header)
    header = undefined
    result.push(item)
  }
  return result
}
