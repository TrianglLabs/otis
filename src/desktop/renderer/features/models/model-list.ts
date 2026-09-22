import type { ModelPickerChoice, ModelPickerItem } from "../../../../inference/picker-catalog.js"
import type { DesktopStatus } from "../../../contracts.js"
import { formatContextWindow } from "../../format.js"
import { englishT } from "../../i18n/index.js"
import type { Translate } from "../../i18n/messages/en.js"

/** The identifier `selectModel` expects: the item id, or the selectionKey for PAIR entries. */
export function pickerItemKey(item: ModelPickerChoice): string {
  return "selectionKey" in item ? item.selectionKey : item.id
}

/**
 * Overlays an in-flight load's progress or terminal error onto its catalog row. The catalog is
 * fetched once per picker open, so the per-tick updates the main process streams through status
 * events are merged in client-side.
 */
export function mergeModelLoad(
  items: ModelPickerItem[],
  modelLoad: DesktopStatus["modelLoad"],
): ModelPickerItem[] {
  if (!modelLoad) return items
  return items.map((item) =>
    item.kind === "model" && pickerItemKey(item) === modelLoad.modelId
      ? { ...item, status: modelLoad.status }
      : item,
  )
}

/**
 * Mirrors isSelectablePickerItem from the picker catalog. Duplicated deliberately: the catalog
 * module pulls Node-only dependencies (hardware probe, GGUF cache) that must stay out of the
 * renderer bundle.
 */
export function isPickerRowSelectable(
  item: ModelPickerItem | undefined,
): item is ModelPickerChoice & { available: true } {
  return item?.kind === "model" && item.available === true
}

type PickerDetailPart = { label: string; modality?: "text" | "vision" }

/**
 * Structured row metadata lets the GUI decorate capabilities without parsing the TUI-compatible
 * label.
 */
export function pickerDetailParts(
  item: ModelPickerChoice,
  t: Translate = englishT,
): PickerDetailPart[] {
  const modality: PickerDetailPart = item.supportsImageInput
    ? { label: t("models.vision"), modality: "vision" }
    : { label: t("models.text"), modality: "text" }
  if (item.provider === "local") {
    return [{ label: item.availabilityLabel }, modality]
  }
  if (item.provider === "omlx" && item.availabilityLabel)
    return [{ label: item.availabilityLabel }, modality]
  if (item.provider === "pair") {
    return [
      { label: item.engine === "ollama" ? "Ollama" : "LM Studio" },
      {
        label: item.nativeContextLength
          ? t("models.modelMax", { count: formatContextWindow(item.nativeContextLength) })
          : t("models.contextUnavailable"),
      },
      { label: item.quantization ?? t("models.quantUnavailable") },
      modality,
    ]
  }
  const parts: PickerDetailPart[] = item.provider === "omlx" ? [{ label: "oMLX" }] : []
  if (item.contextLength) parts.push({ label: formatContextWindow(item.contextLength) })
  parts.push(modality)
  if (item.provider === "fireworks" && item.fastId) parts.push({ label: t("models.fastMode") })
  return parts
}

/**
 * Row subtitle when no live status overrides it. Mirrors modelMeta in the TUI's model picker
 * (src/cli/ui/model-picker.ts) string-for-string — "Est." is a managed-local concept, hosted rows
 * show the exact context — except that PAIR rows also lead with the engine label the TUI renders as
 * a name suffix, since this picker has no suffix column.
 */
export function pickerDetailLabel(item: ModelPickerChoice, t: Translate = englishT): string {
  return pickerDetailParts(item, t)
    .map((part) => part.label)
    .join(" · ")
}
