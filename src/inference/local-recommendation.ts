import { type HardwareProbe, inferenceMemoryBudget } from "./hardware.js"
import { supportsLlamaCppTarget } from "./llama-binary.js"
import { findLocalModel } from "./local-catalog.js"
import { fitLocalModel } from "./local-fit.js"

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

export function recommendedLocalModelIds(hardware: HardwareProbe): readonly string[] {
  if (
    !supportsLlamaCppTarget(hardware) ||
    !Number.isFinite(hardware.totalMemoryBytes) ||
    hardware.totalMemoryBytes <= 0
  ) {
    return []
  }

  // Unknown VRAM cannot establish GPU residency. Use host fit in that case,
  // just as for CPU inference; this is not a promise of GPU acceleration.
  const gpuMemoryBudget = inferenceMemoryBudget(hardware).gpuMemoryBudgetBytes
  if (gpuMemoryBudget !== undefined && (!Number.isFinite(gpuMemoryBudget) || gpuMemoryBudget <= 0)) return []

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
