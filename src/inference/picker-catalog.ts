import { listToolCapableModels } from "./catalog.js"
import { isAnyLocalModelPackingDownloaded, isLocalGgufDownloaded } from "./gguf-cache.js"
import { detectHardware, type HardwareProbe } from "./hardware.js"
import { supportsLlamaCppTarget, unsupportedLlamaCppTargetMessage } from "./llama-binary.js"
import { isLocalModelId, LOCAL_MODELS } from "./local-catalog.js"
import { fitLocalModel, formatMemoryLabel, type LocalModelFit, memoryRequiredFor } from "./local-fit.js"
import { recommendedLocalModelIds } from "./local-recommendation.js"
import { pairModelKey } from "./pair.js"
import { matchesFireworksModel } from "./serving-path.js"
import type {
  FireworksModel,
  LocalCatalogModel,
  ModelProvider,
  OmlxCatalogModel,
  PairCatalogModel,
  PairEngine,
} from "./types.js"

export type ModelPickerItem = ModelPickerHeader | ModelPickerChoice

export type ModelPickerHeader = {
  kind: "header"
  id: string
  displayName: string
}

export type ModelPickerStatus = {
  label: string
  kind: "progress" | "error"
}

export type LocalPickerChoice = LocalCatalogModel & {
  kind: "model"
  available: boolean
  recommended: boolean
  availabilityLabel: string
  loadedContextLength?: number
  /** At least one packing for this model is cached, including one selected for different hardware. */
  hasDownloadedPacking: boolean
  downloaded: boolean
  status?: ModelPickerStatus
  active: boolean
}

export type FireworksPickerChoice = FireworksModel & {
  kind: "model"
  available: true
  active: boolean
  status?: ModelPickerStatus
}

export type PairPickerChoice = PairCatalogModel & {
  kind: "model"
  available: true
  active: boolean
  selectionKey: string
  status?: ModelPickerStatus
}

export type OmlxPickerChoice = OmlxCatalogModel & {
  kind: "model"
  available: true
  active: boolean
  selectionKey: string
  status?: ModelPickerStatus
}

export type ModelPickerChoice = LocalPickerChoice | FireworksPickerChoice | PairPickerChoice | OmlxPickerChoice

export type ListModelPickerOptions = {
  fireworksApiKey?: string
  currentModel?: string
  currentProvider?: ModelProvider
  currentPairEngine?: PairEngine
  pairModels?: readonly PairCatalogModel[]
  omlxModels?: readonly OmlxCatalogModel[]
  hardware?: HardwareProbe
  dataDirectory?: string
  loadStatus?: { modelId: string; status: ModelPickerStatus }
  loadedLocalModel?: { model: string; contextLength: number }
  detect?: typeof detectHardware
  listFireworks?: typeof listToolCapableModels
  /**
   * Keep downloaded local models listed even when they cannot run on this machine — selection stays
   * unavailable. The desktop catalog opts in so cached files remain deletable from the GUI; the default
   * (CLI) behavior keeps them hidden.
   */
  includeDownloadedUnavailable?: boolean
  signal?: AbortSignal
}

export async function listModelPickerItems(options: ListModelPickerOptions = {}): Promise<ModelPickerItem[]> {
  const hardware = options.hardware ?? (await (options.detect ?? detectHardware)())
  const currentProvider =
    options.currentProvider ??
    (options.currentModel ? (isLocalModelId(options.currentModel) ? "local" : "fireworks") : undefined)
  const currentLocalModel = currentProvider === "local" ? options.currentModel : undefined
  const currentFireworksModel = currentProvider === "fireworks" ? options.currentModel : undefined
  const localUnavailableReason = supportsLlamaCppTarget(hardware)
    ? undefined
    : unsupportedLlamaCppTargetMessage(hardware)
  const recommendedModelIds = new Set(recommendedLocalModelIds(hardware))
  const localItems = (
    await Promise.all(
      LOCAL_MODELS.map(async (model) => {
        const fit = fitLocalModel(model, hardware)
        const selectedModel = fit.model
        const downloaded = await isLocalGgufDownloaded(selectedModel, options.dataDirectory)
        const hasDownloadedPacking =
          downloaded || (await isAnyLocalModelPackingDownloaded(model, options.dataDirectory))
        if (!fit.available && !(options.includeDownloadedUnavailable === true && hasDownloadedPacking)) return undefined
        const loadedContextLength =
          currentLocalModel === model.id && options.loadedLocalModel?.model === model.id
            ? options.loadedLocalModel.contextLength
            : undefined
        return toLocalPickerChoice(
          selectedModel,
          fit,
          recommendedModelIds,
          localUnavailableReason,
          loadedContextLength,
          currentLocalModel,
          downloaded,
          hasDownloadedPacking,
          options.loadStatus,
        )
      }),
    )
  ).filter((item): item is LocalPickerChoice => item !== undefined)

  const fireworks = await loadFireworksModels(options)

  return [
    ...localSection(localItems),
    ...pairSection(options.pairModels ?? [], options),
    ...omlxSection(options.omlxModels ?? [], options),
    ...fireworksSection(fireworks, currentFireworksModel),
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

export function toPairCatalogModel(item: PairPickerChoice): PairCatalogModel {
  const {
    kind: _kind,
    available: _available,
    active: _active,
    selectionKey: _selectionKey,
    status: _status,
    ...model
  } = item
  return model
}

export function toOmlxCatalogModel(item: OmlxPickerChoice): OmlxCatalogModel {
  return {
    provider: "omlx",
    id: item.id,
    displayName: item.displayName,
    baseURL: item.baseURL,
    contextLength: item.contextLength,
    supportsImageInput: item.supportsImageInput,
  }
}

function omlxSection(models: readonly OmlxCatalogModel[], options: ListModelPickerOptions): ModelPickerItem[] {
  if (!models.length) return []
  return [
    { kind: "header", id: "header-omlx", displayName: "oMLX" },
    ...models.map((model): OmlxPickerChoice => {
      const selectionKey = `omlx:${model.id}`
      return {
        ...model,
        kind: "model",
        available: true,
        selectionKey,
        active: options.currentProvider === "omlx" && options.currentModel === model.id,
        ...(options.loadStatus?.modelId === selectionKey ? { status: options.loadStatus.status } : {}),
      }
    }),
  ]
}

function fireworksSection(models: readonly FireworksModel[], currentModel?: string): ModelPickerItem[] {
  if (models.length === 0) return []
  return [
    { kind: "header", id: "header-hosted", displayName: "Hosted" },
    ...models.map((model) => toFireworksPickerChoice(model, currentModel)),
  ]
}

function localSection(models: readonly LocalPickerChoice[]): ModelPickerItem[] {
  if (models.length === 0) return []
  return [{ kind: "header", id: "header-local", displayName: "Local" }, ...models]
}

function pairSection(models: readonly PairCatalogModel[], options: ListModelPickerOptions): ModelPickerItem[] {
  if (models.length === 0) return []
  return [
    { kind: "header", id: "header-pair", displayName: "NVIDIA PAIR" },
    ...models.map((model): PairPickerChoice => {
      const selectionKey = pairModelKey(model)
      return {
        ...model,
        kind: "model",
        available: true,
        active:
          options.currentProvider === "pair" &&
          options.currentModel === model.id &&
          options.currentPairEngine === model.engine,
        selectionKey,
        // Load status is keyed like the renderer's rows: PAIR entries by selectionKey, not the bare model id.
        ...(options.loadStatus?.modelId === selectionKey ? { status: options.loadStatus.status } : {}),
      }
    }),
  ]
}

function toLocalPickerChoice(
  model: (typeof LOCAL_MODELS)[number],
  fit: ReturnType<typeof fitLocalModel>,
  recommendedModelIds: ReadonlySet<string>,
  localUnavailableReason: string | undefined,
  loadedContextLength: number | undefined,
  currentModel: string | undefined,
  downloaded: boolean,
  hasDownloadedPacking: boolean,
  loadStatus?: { modelId: string; status: ModelPickerStatus },
): LocalPickerChoice {
  return {
    kind: "model",
    provider: "local",
    id: model.id,
    displayName: model.displayName,
    contextLength: loadedContextLength ?? (fit.available ? fit.contextLength : model.nativeContextLength),
    supportsImageInput: model.supportsImageInput,
    available: localUnavailableReason === undefined && fit.available,
    recommended: localUnavailableReason === undefined && fit.available && recommendedModelIds.has(model.id),
    availabilityLabel: localAvailabilityLabel(model, fit, localUnavailableReason, loadedContextLength),
    ...(loadedContextLength === undefined ? {} : { loadedContextLength }),
    downloaded,
    hasDownloadedPacking,
    status: loadStatus?.modelId === model.id ? loadStatus.status : undefined,
    active: currentModel === model.id,
  }
}

function localAvailabilityLabel(
  model: (typeof LOCAL_MODELS)[number],
  fit: LocalModelFit,
  localUnavailableReason: string | undefined,
  loadedContextLength: number | undefined,
) {
  if (localUnavailableReason) return localUnavailableReason
  if (loadedContextLength !== undefined) {
    return `${formatContextWindow(loadedContextLength)} · ${model.quant} · ${formatMemoryLabel(memoryRequiredFor(model, loadedContextLength))}`
  }
  if (!fit.available) return `Needs ${formatMemoryLabel(fit.memoryRequiredBytes)}`
  return `Est. ${formatContextWindow(fit.contextLength)} · ${model.quant} · ${formatMemoryLabel(fit.memoryRequiredBytes)}`
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
