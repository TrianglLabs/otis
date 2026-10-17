/** Picker search, kept free of Node modules so the desktop renderer can import it. */

import type { ModelPickerChoice, ModelPickerHeader, ModelPickerItem } from "./picker-catalog.js"
import { HOSTED_PROVIDER_INFO, isServerProvider, type ModelProvider, SERVER_INFO } from "./types.js"

/**
 * A model named by its provider and catalog id: how settings record a hidden model, and how a
 * picker row is keyed, since a hosted catalog can list the very id a managed-local model uses.
 */
export function modelKey(provider: ModelProvider, id: string) {
  return `${provider}:${id}`
}

/**
 * One key per picker row, for selection, load status, and rendering: PAIR and server rows carry
 * theirs, built the same way with the engine in between; local and hosted rows are keyed here.
 */
export function pickerItemKey(item: ModelPickerChoice): string {
  return "selectionKey" in item ? item.selectionKey : modelKey(item.provider, item.id)
}

/** What a picker row's provider is called, for search and labels. */
export function providerLabel(provider: ModelProvider) {
  if (provider === "local") return "Local"
  if (provider === "pair") return "NVIDIA PAIR"
  if (isServerProvider(provider)) return SERVER_INFO[provider].name
  return HOSTED_PROVIDER_INFO[provider].name
}

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean)

/**
 * The rows matching `query`, each under its section header; headers without a match are
 * dropped. Every word typed must begin a word of the row's name, the last segment of its id, or
 * its provider, so "glm 5" finds GLM-5.3 and "fire" the Fireworks rows, while "model" no longer
 * finds every `accounts/fireworks/models/…` id and "ai" every `-ai` organization.
 */
export function filterModelPickerItems(
  items: readonly ModelPickerItem[],
  query: string,
): ModelPickerItem[] {
  const needles = words(query)
  if (needles.length === 0) return [...items]
  const result: ModelPickerItem[] = []
  let header: ModelPickerHeader | undefined
  for (const item of items) {
    if (item.kind === "header") {
      header = item
      continue
    }
    const haystack = words(
      `${item.displayName} ${item.id.split("/").at(-1)} ${providerLabel(item.provider)}`,
    )
    if (!needles.every((needle) => haystack.some((word) => word.startsWith(needle)))) continue
    if (header) result.push(header)
    header = undefined
    result.push(item)
  }
  return result
}
