const GIBIBYTE = 1024 ** 3

const MINIMUM_LOCAL_MEMORY_BYTES = 8 * GIBIBYTE
const ORNITH_MEMORY_BYTES = 16 * GIBIBYTE
const QWEN_MEMORY_BYTES = 24 * GIBIBYTE
const QWEN_FLASH_NEXT_MEMORY_BYTES = 96 * GIBIBYTE
const GLM_FLASH_MEMORY_BYTES = 196 * GIBIBYTE
const GLM_MEMORY_BYTES = 384 * GIBIBYTE
const MAXIMUM_RECOMMENDED_MEMORY_BYTES = 512 * GIBIBYTE

export function recommendedLocalModelIds(totalMemoryBytes: number): readonly string[] {
  if (
    !Number.isFinite(totalMemoryBytes) ||
    totalMemoryBytes < MINIMUM_LOCAL_MEMORY_BYTES ||
    totalMemoryBytes > MAXIMUM_RECOMMENDED_MEMORY_BYTES
  ) {
    return []
  }
  if (totalMemoryBytes < ORNITH_MEMORY_BYTES) return ["LiquidAI/LFM2.5-2.6B"]
  if (totalMemoryBytes < QWEN_MEMORY_BYTES) {
    return ["ornith-ai/Ornith-1.5-9B", "google/gemma-4-12B-it"]
  }
  if (totalMemoryBytes < QWEN_FLASH_NEXT_MEMORY_BYTES) return ["Qwen/Qwen3.8-27B"]
  if (totalMemoryBytes < GLM_FLASH_MEMORY_BYTES) return ["Qwen/Qwen3.8-Flash-Next"]
  // GLM-5.3-Flash remains unlisted until its upstream llama.cpp support lands.
  if (totalMemoryBytes < GLM_MEMORY_BYTES) return []
  return ["zai-org/GLM-5.3"]
}
