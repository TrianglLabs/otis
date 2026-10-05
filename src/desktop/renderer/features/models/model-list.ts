import type {
  LocalPickerChoice,
  ModelPickerChoice,
  ModelPickerItem,
} from "../../../../inference/picker-catalog.js"
import { isServerProvider, SERVER_INFO } from "../../../../inference/types.js"
import type { DesktopStatus } from "../../../contracts.js"
import { formatContextWindow, formatMemory } from "../../format.js"
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
  // `in`, not isServerPickerChoice: the picker catalog's module graph is Node-only.
  if ("availabilityLabel" in item && item.availabilityLabel)
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
  const parts: PickerDetailPart[] = isServerProvider(item.provider)
    ? [{ label: SERVER_INFO[item.provider].name }]
    : []
  if (item.contextLength) parts.push({ label: formatContextWindow(item.contextLength) })
  parts.push(modality)
  // Fast serving is a Fireworks path; other hosted providers never publish a fastId.
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

/**
 * A local model's figures explained one per line: what the context, memory, quantization, and
 * input kind mean for someone who has not run a model before. Figures the catalog did not
 * measure are left out.
 */
export function localModelFacts(item: LocalPickerChoice, t: Translate, locale: string) {
  const words = (Math.round((item.contextLength * 0.75) / 1000) * 1000).toLocaleString(locale)
  // The first number in a packing name is its bits per weight: Q4_K_M, IQ3_XS, PQ2_0, F16.
  const bits = Number(item.quant?.match(/\d+/)?.[0])
  const facts: { term: string; value: string; hint?: string }[] = [
    {
      term: t("models.factContextTerm"),
      value: t("models.factTokens", { count: formatContextWindow(item.contextLength) }),
      hint: t("models.factContext", { words }),
    },
  ]
  if (item.memoryBytes !== undefined) {
    facts.push({
      term: t("models.factMemoryTerm"),
      value: formatMemory(item.memoryBytes),
      hint: item.cpuOffload
        ? `${t("models.factMemory")} · ${t("models.partlyOnCpu")}`
        : t("models.factMemory"),
    })
  }
  if (item.quant && bits) {
    facts.push({
      term: t("models.factQualityTerm"),
      value: bits >= 16 ? t("models.factQuantFull") : t("models.factQuantBits", { bits }),
      hint: t(
        bits <= 3
          ? "models.factQuantLowHint"
          : bits < 8
            ? "models.factQuantMidHint"
            : bits < 16
              ? "models.factQuantHighHint"
              : "models.factQuantFullHint",
        { quant: item.quant },
      ),
    })
  }
  facts.push({
    term: t("models.factInputTerm"),
    value: t(item.supportsImageInput ? "models.factInputVision" : "models.factInputText"),
  })
  return facts
}
