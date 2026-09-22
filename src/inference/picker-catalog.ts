import { listToolCapableModels } from "./catalog.js"
import { LOCAL_MIN_CONTEXT_LENGTH } from "./context-policy.js"
import { isAnyLocalModelPackingDownloaded, isLocalGgufDownloaded } from "./gguf-cache.js"
import { detectHardware, type HardwareProbe, inferenceMemoryBudget } from "./hardware.js"
import { supportsLlamaCppTarget, unsupportedLlamaCppTargetMessage } from "./llama-binary.js"
import { findLocalModel, isLocalModelId, LOCAL_MODELS } from "./local-catalog.js"
import { fitLocalModel, formatMemoryLabel, memoryRequiredFor } from "./local-fit.js"
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

type ModelPickerHeader = {
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
  /**
   * At least one packing for this model is cached, including one selected for different
   * hardware.
   */
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
  available: boolean
  availabilityLabel?: string
  active: boolean
  selectionKey: string
  status?: ModelPickerStatus
}

export type ModelPickerChoice =
  | LocalPickerChoice
  | FireworksPickerChoice
  | PairPickerChoice
  | OmlxPickerChoice

type ListModelPickerOptions = {
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
   * Keep downloaded local models listed even when they cannot run on this machine — selection
   * stays unavailable. The desktop catalog opts in so cached files remain deletable from the
   * GUI; the default (CLI) behavior keeps them hidden.
   */
  includeDownloadedUnavailable?: boolean
  signal?: AbortSignal
}

// Curated preference order, not a ranking inferred from parameter count or file size.
// Peers in a group are offered together; an unavailable group falls back to the next.
const RECOMMENDATION_GROUPS: readonly (readonly string[])[] = [
  ["zai-org/GLM-5.3"],
  ["Qwen/Qwen3.8-Flash-Next"],
  ["Qwen/Qwen3.8-27B"],
  ["prism-ml/Ternary-Bonsai-2-27B-gguf"],
  ["ornith-ai/Ornith-1.5-9B", "google/gemma-4-12B-it"],
  ["LiquidAI/LFM2.5-2.6B"],
]

function recommendedLocalModelIds(hardware: HardwareProbe): readonly string[] {
  const total = hardware.totalMemoryBytes
  if (!supportsLlamaCppTarget(hardware) || !Number.isFinite(total) || total <= 0) return []
  // Unknown VRAM cannot establish GPU residency. Use host fit in that case,
  // just as for CPU inference; this is not a promise of GPU acceleration.
  const gpu = inferenceMemoryBudget(hardware).gpuMemoryBudgetBytes
  if (gpu !== undefined && (!Number.isFinite(gpu) || gpu <= 0)) return []
  for (const group of RECOMMENDATION_GROUPS) {
    const fitting = group.filter((id) => {
      const model = findLocalModel(id)
      if (!model) return false
      const fit = fitLocalModel(model, hardware)
      return fit.available && !fit.requiresCpuOffload
    })
    if (fitting.length > 0) return fitting
  }
  return []
}

export async function listModelPickerItems(
  options: ListModelPickerOptions = {},
): Promise<ModelPickerItem[]> {
  const hardware = options.hardware ?? (await (options.detect ?? detectHardware)())
  const currentProvider =
    options.currentProvider ??
    (options.currentModel
      ? isLocalModelId(options.currentModel)
        ? "local"
        : "fireworks"
      : undefined)
  const currentLocalModel = currentProvider === "local" ? options.currentModel : undefined
  const unsupported = supportsLlamaCppTarget(hardware)
    ? undefined
    : unsupportedLlamaCppTargetMessage(hardware)
  const recommendedModelIds = new Set(recommendedLocalModelIds(hardware))
  const status = (key: string) =>
    options.loadStatus?.modelId === key ? { status: options.loadStatus.status } : {}
  const localItems = (
    await Promise.all(
      LOCAL_MODELS.map(async (model): Promise<LocalPickerChoice | undefined> => {
        const fit = fitLocalModel(model, hardware)
        const selected = fit.model
        const downloaded = await isLocalGgufDownloaded(selected, options.dataDirectory)
        const hasDownloadedPacking =
          downloaded || (await isAnyLocalModelPackingDownloaded(model, options.dataDirectory))
        if (
          !fit.available &&
          !(options.includeDownloadedUnavailable === true && hasDownloadedPacking)
        )
          return undefined
        const loaded =
          currentLocalModel === model.id && options.loadedLocalModel?.model === model.id
            ? options.loadedLocalModel.contextLength
            : undefined
        let availabilityLabel: string
        if (unsupported) availabilityLabel = unsupported
        else if (loaded !== undefined) {
          const cost = formatMemoryLabel(memoryRequiredFor(selected, loaded))
          availabilityLabel = `${formatContextWindow(loaded)} · ${selected.quant} · ${cost}`
        } else if (!fit.available)
          availabilityLabel = `Needs ${formatMemoryLabel(fit.memoryRequiredBytes)}`
        else {
          const offload = fit.requiresCpuOffload ? " · Uses system RAM" : ""
          const cost = formatMemoryLabel(fit.memoryRequiredBytes)
          availabilityLabel = `Est. ${formatContextWindow(fit.contextLength)} · ${selected.quant} · ${cost}${offload}`
        }
        return {
          kind: "model",
          provider: "local",
          id: selected.id,
          displayName: selected.displayName,
          contextLength:
            loaded ?? (fit.available ? fit.contextLength : selected.nativeContextLength),
          supportsImageInput: selected.supportsImageInput,
          available: !unsupported && fit.available,
          recommended: !unsupported && fit.available && recommendedModelIds.has(selected.id),
          availabilityLabel,
          ...(loaded === undefined ? {} : { loadedContextLength: loaded }),
          downloaded,
          hasDownloadedPacking,
          status:
            options.loadStatus?.modelId === selected.id ? options.loadStatus.status : undefined,
          active: currentLocalModel === selected.id,
        }
      }),
    )
  ).filter((item) => item !== undefined)

  let fireworks: readonly FireworksModel[] = []
  if (options.fireworksApiKey) {
    const list = options.listFireworks ?? listToolCapableModels
    fireworks = await list(options.fireworksApiKey, { signal: options.signal }).catch(() => [])
  }
  const pairModels = options.pairModels ?? []
  const omlxModels = options.omlxModels ?? []
  const currentFireworksModel = currentProvider === "fireworks" ? options.currentModel : undefined
  const header = (id: string, displayName: string): ModelPickerHeader => ({
    kind: "header",
    id,
    displayName,
  })
  return [
    ...(localItems.length ? [header("header-local", "Local"), ...localItems] : []),
    ...(pairModels.length ? [header("header-pair", "NVIDIA PAIR")] : []),
    ...pairModels.map((model): PairPickerChoice => {
      // Load status is keyed like the renderer's rows: PAIR entries by selectionKey, not the
      // bare model id.
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
        ...status(selectionKey),
      }
    }),
    ...(omlxModels.length ? [header("header-omlx", "oMLX")] : []),
    ...omlxModels.map((model): OmlxPickerChoice => {
      const selectionKey = `omlx:${model.id}`
      const available =
        model.contextLength === undefined || model.contextLength >= LOCAL_MIN_CONTEXT_LENGTH
      return {
        ...model,
        kind: "model",
        available,
        ...(available
          ? {}
          : { availabilityLabel: "Requires 64K context. Increase the model's context in oMLX." }),
        selectionKey,
        active: options.currentProvider === "omlx" && options.currentModel === model.id,
        ...status(selectionKey),
      }
    }),
    ...(fireworks.length ? [header("header-hosted", "Hosted")] : []),
    ...fireworks.map((model) => toFireworksPickerChoice(model, currentFireworksModel)),
  ]
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
    selectionKey: _key,
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

function toFireworksPickerChoice(
  model: FireworksModel,
  currentModel?: string,
): FireworksPickerChoice {
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
  if (tokens < 1_000) return String(tokens)
  if (tokens % 1_000 === 0) return `${tokens / 1_000}K`
  if (tokens % 1_024 === 0) return `${tokens / 1_024}K`
  return `${Math.round(tokens / 1_000)}K`
}
