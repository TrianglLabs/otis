import { listToolCapableModels } from "./catalog.js"
import { isLocalGgufDownloaded } from "./gguf-cache.js"
import { currentlyAvailableInferenceMemory, detectHardware, type HardwareProbe } from "./hardware.js"
import { LOCAL_MODELS } from "./local-catalog.js"
import {
  fitLocalModel,
  fitLocalModelWithinMemory,
  formatMemoryLabel,
  type LocalModelFit,
  memoryRequiredFor,
} from "./local-fit.js"
import { matchesFireworksModel } from "./serving-path.js"
import type { FireworksModel, LocalCatalogModel } from "./types.js"

export type ModelPickerItem = ModelPickerHeader | ModelPickerChoice

export type ModelPickerHeader = {
  kind: "header"
  id: string
  displayName: string
}

export type LocalPickerChoice = LocalCatalogModel & {
  kind: "model"
  available: boolean
  availabilityLabel: string
  loadedContextLength?: number
  downloaded: boolean
  statusLabel?: string
  active: boolean
}

export type FireworksPickerChoice = FireworksModel & {
  kind: "model"
  available: true
  active: boolean
}

export type ModelPickerChoice = LocalPickerChoice | FireworksPickerChoice

export type ListModelPickerOptions = {
  fireworksApiKey?: string
  currentModel?: string
  hardware?: HardwareProbe
  dataDirectory?: string
  loadStatus?: { modelId: string; label: string }
  loadedLocalModel?: { model: string; contextLength: number }
  detect?: typeof detectHardware
  listFireworks?: typeof listToolCapableModels
  signal?: AbortSignal
}

export async function listModelPickerItems(options: ListModelPickerOptions = {}): Promise<ModelPickerItem[]> {
  const hardware = options.hardware ?? (await (options.detect ?? detectHardware)())
  const currentInferenceMemory =
    hardware.gpuMemoryFreeBytes !== undefined ? currentlyAvailableInferenceMemory(hardware) : undefined
  const localItems = await Promise.all(
    LOCAL_MODELS.map(async (model) => {
      const fit = fitLocalModel(model, hardware)
      const currentFit =
        currentInferenceMemory === undefined ? fit : fitLocalModelWithinMemory(model, currentInferenceMemory)
      const loadedContextLength =
        options.currentModel === model.id && options.loadedLocalModel?.model === model.id
          ? options.loadedLocalModel.contextLength
          : undefined
      const downloaded = await isLocalGgufDownloaded(model, options.dataDirectory)
      return toLocalPickerChoice(
        model,
        fit,
        currentFit,
        loadedContextLength,
        options.currentModel,
        downloaded,
        options.loadStatus,
      )
    }),
  )

  const fireworks = await loadFireworksModels(options)

  return [
    { kind: "header", id: "header-local", displayName: "Local" },
    ...localItems,
    ...fireworksSection(fireworks, options.currentModel),
  ]
}

async function loadFireworksModels(options: ListModelPickerOptions) {
  if (!options.fireworksApiKey) return []
  try {
    return await (options.listFireworks ?? listToolCapableModels)(options.fireworksApiKey, { signal: options.signal })
  } catch {
    return []
  }
}

export function isSelectablePickerItem(
  item: ModelPickerItem | undefined,
): item is ModelPickerChoice & { available: true } {
  return item?.kind === "model" && item.available === true
}

export function toLocalCatalogModel(item: LocalPickerChoice): LocalCatalogModel {
  return {
    provider: "local",
    id: item.id,
    displayName: item.displayName,
    contextLength: item.contextLength,
    supportsImageInput: item.supportsImageInput,
  }
}

function fireworksSection(models: readonly FireworksModel[], currentModel?: string): ModelPickerItem[] {
  if (models.length === 0) return []
  return [
    { kind: "header", id: "header-fireworks", displayName: "Fireworks" },
    ...models.map((model) => toFireworksPickerChoice(model, currentModel)),
  ]
}

function toLocalPickerChoice(
  model: (typeof LOCAL_MODELS)[number],
  fit: ReturnType<typeof fitLocalModel>,
  currentFit: LocalModelFit,
  loadedContextLength: number | undefined,
  currentModel: string | undefined,
  downloaded: boolean,
  loadStatus?: { modelId: string; label: string },
): LocalPickerChoice {
  return {
    kind: "model",
    provider: "local",
    id: model.id,
    displayName: model.displayName,
    contextLength:
      loadedContextLength ??
      (currentFit.available ? currentFit.contextLength : fit.available ? fit.contextLength : model.nativeContextLength),
    supportsImageInput: model.supportsImageInput,
    available: fit.available,
    availabilityLabel: localAvailabilityLabel(model, fit, currentFit, loadedContextLength),
    ...(loadedContextLength === undefined ? {} : { loadedContextLength }),
    downloaded,
    statusLabel: loadStatus?.modelId === model.id ? loadStatus.label : undefined,
    active: currentModel === model.id,
  }
}

function localAvailabilityLabel(
  model: (typeof LOCAL_MODELS)[number],
  fit: LocalModelFit,
  currentFit: LocalModelFit,
  loadedContextLength: number | undefined,
) {
  if (loadedContextLength !== undefined) {
    return `${formatContextWindow(loadedContextLength)} loaded · ${model.quant} · ${formatMemoryLabel(memoryRequiredFor(model, loadedContextLength))}`
  }
  if (!fit.available) return `Needs ${formatMemoryLabel(fit.memoryRequiredBytes)}`
  const recommendation = currentFit.available ? currentFit : fit
  return `Up to ${formatContextWindow(recommendation.contextLength)} · ${model.quant} · ${formatMemoryLabel(recommendation.memoryRequiredBytes)}`
}

export function toFireworksPickerChoice(model: FireworksModel, currentModel?: string): FireworksPickerChoice {
  return {
    kind: "model",
    ...model,
    provider: "fireworks",
    available: true,
    active: currentModel ? matchesFireworksModel(model, currentModel) : false,
  }
}

export function formatContextWindow(tokens: number) {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) {
    if (tokens % 1_000 === 0) return `${tokens / 1_000}K`
    if (tokens % 1_024 === 0) return `${tokens / 1_024}K`
    return `${Math.round(tokens / 1_000)}K`
  }
  return String(tokens)
}
