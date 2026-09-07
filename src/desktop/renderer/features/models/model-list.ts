import type { ModelPickerChoice, ModelPickerItem } from "../../../../inference/picker-catalog.js"
import type { DesktopStatus } from "../../../contracts.js"
import { formatContextWindow } from "../../format.js"

/** The identifier `selectModel` expects: the item id, or the selectionKey for PAIR entries. */
export function pickerItemKey(item: ModelPickerChoice): string {
  return item.provider === "pair" ? item.selectionKey : item.id
}

/**
 * Overlays an in-flight load's progress or terminal error onto its catalog row. The catalog is fetched once per
 * picker open, so the per-tick updates the main process streams through status events are merged in client-side.
 */
export function mergeModelLoad(items: ModelPickerItem[], modelLoad: DesktopStatus["modelLoad"]): ModelPickerItem[] {
  if (!modelLoad) return items
  return items.map((item) =>
    item.kind === "model" && pickerItemKey(item) === modelLoad.modelId ? { ...item, status: modelLoad.status } : item,
  )
}

/**
 * Mirrors isSelectablePickerItem from the picker catalog. Duplicated deliberately: the catalog module pulls
 * Node-only dependencies (hardware probe, GGUF cache) that must stay out of the renderer bundle.
 */
export function isPickerRowSelectable(
  item: ModelPickerItem | undefined,
): item is ModelPickerChoice & { available: true } {
  return item?.kind === "model" && item.available === true
}

/** Mirrors FAST_MODE_LABEL in src/cli/ui/format.ts; the CLI module cannot be imported into the renderer bundle. */
const FAST_MODE_LABEL = "Fast mode"

/**
 * Row subtitle when no live status overrides it. Mirrors modelMeta in the TUI's model picker
 * (src/cli/ui/model-picker.ts) string-for-string — "Est." is a managed-local concept, hosted rows show the exact
 * context — except that PAIR rows also lead with the engine label the TUI renders as a name suffix, since this
 * picker has no suffix column.
 */
export function pickerDetailLabel(item: ModelPickerChoice): string {
  const modality = item.supportsImageInput ? "Vision" : "Text"
  if (item.provider === "local") return `${item.availabilityLabel} · ${modality}`
  if (item.provider === "pair") {
    const engine = item.engine === "ollama" ? "Ollama" : "LM Studio"
    const context = item.nativeContextLength
      ? `${formatContextWindow(item.nativeContextLength)} model max`
      : "Context unavailable"
    const quantization = item.quantization ?? "Quant unavailable"
    return `${engine} · ${context} · ${quantization} · ${modality}`
  }
  const parts: string[] = []
  if (item.contextLength) parts.push(formatContextWindow(item.contextLength))
  parts.push(modality)
  if (item.fastId) parts.push(FAST_MODE_LABEL)
  return parts.join(" · ")
}
