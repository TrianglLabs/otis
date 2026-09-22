import { describe, expect, it } from "vitest"
import { estimateTextTokens } from "../../src/inference/messages.js"

/**
 * Reference counts measured with the pinned llama.cpp b10666 `llama-tokenize` on the vocab-only
 * GGUFs from the llama.cpp repository (models/ggml-vocab-qwen2.gguf, ggml-vocab-llama-bpe.gguf)
 * and with `llama-server` `/tokenize` on the catalog's LFM2.5-2.6B-Q4_K_M.gguf, all without BOS.
 * The corpus below is the exact text that was tokenized; the rates in messages.ts were fitted
 * to these counts by least squares, so a rate change must be re-measured, not tuned to pass.
 */
const CORPUS = {
  prose: `The picker lists every curated model with the largest context that fits the detected hardware. When a model is not running, its context and memory figures are estimates: the selected weights, the key-value cache at that context, and the buffers the runtime allocates around them. Otis reserves part of system memory for the operating system and other applications, and keeps a fixed margin on each GPU so the runtime's own allocations do not push the machine into swap. These figures guide the choice before launch. Once a server is running, the loaded context is authoritative and drives the context meter and compaction. A conversation grows with every tool result, so the meter matters most during long sessions with many file reads. Compaction summarizes older exchanges into a structured note and keeps the recent ones verbatim, which preserves the task, the decisions already made, and the next steps without carrying every byte of tool output forward. The summary is written by the same model that continues the work, using its lowest reasoning setting so the request stays within budget. If the model returns a summary that omits a required section, the conversation is left unchanged and the user sees a clear error rather than a silently truncated history. Similar care applies to attachments: an image is billed by its dimensions rather than by its file size, and a document is represented by the text extracted from it together with a small metadata header that identifies the source without copying its bytes into the prompt.`,
  typescript: `export function fitWithinMemory(model: LocalModelSpec, memoryAvailableBytes: number): LocalModelFit {
  const minRequired = memoryRequiredFor(model, LOCAL_MIN_CONTEXT_LENGTH)
  const minimum: LocalModelFit = {
    model,
    available: false,
    contextLength: LOCAL_MIN_CONTEXT_LENGTH,
    memoryRequiredBytes: minRequired,
    memoryAvailableBytes,
    requiresCpuOffload: false,
  }
  if (minRequired > memoryAvailableBytes) return minimum

  // Memory grows monotonically with context, so binary search the largest fitting
  // context and align it down; the minimum is already aligned.
  let low = LOCAL_MIN_CONTEXT_LENGTH
  let high = model.nativeContextLength
  while (low < high) {
    const mid = Math.ceil((low + high + 1) / 2)
    if (memoryRequiredFor(model, mid) <= memoryAvailableBytes) low = mid
    else high = mid - 1
  }
  const contextLength =
    low >= model.nativeContextLength
      ? model.nativeContextLength
      : Math.floor(low / CONTEXT_ALIGNMENT) * CONTEXT_ALIGNMENT
  return {
    ...minimum,
    available: true,
    contextLength,
    memoryRequiredBytes: memoryRequiredFor(model, contextLength),
  }
}

function kvCacheBytes(attention: LocalAttentionSpec, contextLength: number) {
  return attention.groups.reduce((total, group) => {
    const tokens = group.window === undefined ? contextLength : Math.min(contextLength, group.window)
    const bytesPerTokenPerLayer =
      group.bytesPerTokenPerLayer ?? group.kvHeads * group.headDim * KV_ELEMENT_BYTES
    return total + group.layers * bytesPerTokenPerLayer * tokens
  }, 0)
}

export function formatMemoryLabel(bytes: number) {
  const gib = bytes / 1024 ** 3
  return \`\${gib >= 10 ? Math.round(gib) : gib.toFixed(1).replace(/\\.0$/, "")} GB\`
}`,
  json: `{"matches":[{"path":"src/inference/local-fit.ts","line":82,"column":17,"text":"export function memoryRequiredFor(model: LocalModelSpec, contextLength: number) {"},{"path":"src/inference/local-fit.ts","line":90,"column":10,"text":"function kvCacheBytes(attention: LocalAttentionSpec, contextLength: number) {"},{"path":"src/inference/picker-catalog.ts","line":199,"column":42,"text":"const cost = formatMemoryLabel(memoryRequiredFor(selected, loaded))"},{"path":"tests/inference/local-fit.test.ts","line":230,"column":44,"text":"expect(fit.memoryRequiredBytes).toBe(memoryRequiredFor(fit.model, fit.contextLength))"}],"stats":{"filesSearched":412,"filesMatched":3,"elapsedMs":18.4,"truncated":false},"tool":"grep","pattern":"memoryRequiredFor","cwd":"/Users/nikita/Desktop/Projects/otis","exitCode":0,"env":{"HOME":"/Users/nikita","SHELL":"/bin/zsh","TERM":"xterm-256color","LANG":"en_US.UTF-8"},"sizes":{"src/inference/local-fit.ts":3512,"src/inference/picker-catalog.ts":11904,"tests/inference/local-fit.test.ts":14180},"timestamps":["2026-09-22T11:45:03.118Z","2026-09-22T11:45:03.137Z"]}`,
  cjk: `本地推理的内存估算包括三部分：模型权重文件、键值缓存以及运行时分配的计算缓冲区。选择模型时，Otis 会先根据检测到的硬件计算最大可用的上下文长度，再为操作系统和其他应用保留一部分内存。启动服务器之后，实际加载的上下文长度以服务器报告为准，并用于上下文指示器和对话压缩。对话压缩会把较早的交流总结成结构化摘要，同时保留最近的完整工具调用记录，这样既能保留任务目标和已经做出的决定，也不必把所有工具输出逐字带入后续请求。如果模型返回的摘要缺少必需的章节，对话将保持不变，用户会看到明确的错误提示，而不是被悄悄截断的历史记录。附件的处理同样谨慎：图片按照像素尺寸而不是文件大小计费，文档则以提取出的文本加上一个小的元数据头表示，元数据用于标识来源，但不会把原始字节复制到提示词中。日本語の段落も含めます。ローカル推論では、モデルの重み、キー・バリューキャッシュ、そして実行時バッファの合計がメモリ使用量の見積もりになります。`,
  diff: `diff --git a/src/inference/local-fit.ts b/src/inference/local-fit.ts
index 3f1c2a9..b7e40d1 100644
--- a/src/inference/local-fit.ts
+++ b/src/inference/local-fit.ts
@@ -10,9 +10,12 @@ import {
-// The pinned llama.cpp estimator reports roughly 1.1 GiB of compute buffers for
-// the largest-context catalog model. Keep additional margin because graph memory
-// is architecture- and backend-dependent; llama.cpp remains authoritative at load.
-const RUNTIME_OVERHEAD_BYTES = 1.5 * 1024 ** 3
+// Runtime buffers that do not scale with the weights: the f32 logits buffer for a
+// full batch, the flash-attention mask and activations for one micro-batch, and a
+// fixed floor for the backend's own allocations. llama.cpp remains authoritative.
+const LOGITS_BATCH = 2_048
+const MICRO_BATCH = 512
+const RUNTIME_FLOOR_BYTES = 512 * 1024 ** 2
 const KV_ELEMENT_BYTES = 4 // f16 key + f16 value
 const CONTEXT_ALIGNMENT = 1_024
@@ -82,11 +85,20 @@ export function memoryRequiredFor(model: LocalModelSpec, contextLength: number) {
   return (
     localModelWeightBytes(model) +
     kvCacheBytes(model.attention, contextLength) +
-    RUNTIME_OVERHEAD_BYTES
+    runtimeOverheadBytes(model, contextLength)
   )
 }
 
+function runtimeOverheadBytes(model: LocalModelSpec, contextLength: number) {
+  const logits = model.vocabSize * LOGITS_BATCH * 4
+  const mask = contextLength * MICRO_BATCH * 2
+  const activations = model.hiddenSize * MICRO_BATCH * 4 * 8
+  return RUNTIME_FLOOR_BYTES + logits + mask + activations
+}
+
 function kvCacheBytes(attention: LocalAttentionSpec, contextLength: number) {
   return attention.groups.reduce((total, group) => {
     const tokens =
       group.window === undefined ? contextLength : Math.min(contextLength, group.window)`,
}

const REFERENCE_TOKENS = {
  qwen2: { prose: 285, typescript: 425, json: 350, cjk: 261, diff: 492 },
  llama3: { prose: 285, typescript: 422, json: 309, cjk: 308, diff: 465 },
  lfm25: { prose: 293, typescript: 451, json: 329, cjk: 278, diff: 514 },
} as const

/** Mixed, digit-heavy, and non-CJK non-ASCII text measured the same way, as a looser check. */
const SAMPLES = {
  casual: `hey, can you take a look at the login page? it's broken again after the last deploy. I think it's the same thing we saw last week where the button doesn't do anything until you refresh. Not sure if it's the cache or the new script. Also the tests are green so I don't get it. Could you check the logs and tell me what's going on? Thanks! Oh and one more thing, the footer links are wrong on mobile, they overlap with the cookie banner. Not urgent but annoying.`,
  markdown: `Here's what I found:

- The button handler is attached in \`setupLogin()\`, which runs before the DOM is ready.
- After the deploy, the script moved from the footer to the \`<head>\`, so it now runs too early.

The fix is to defer the script or wait for \`DOMContentLoaded\`:

\`\`\`ts
document.addEventListener("DOMContentLoaded", () => {
  setupLogin(document.querySelector("#login-form"))
})
\`\`\`

I also checked the footer: the cookie banner uses \`position: fixed\` with a z-index above the links. Adding bottom padding to the footer on small screens resolves the overlap.`,
  system: `You are Otis, a general interactive terminal agent. Use the available tools to read and modify files, run commands, and search the web when needed. Prefer small, verifiable changes. Ask before destructive operations. When the user asks a question, answer directly and cite file paths. Keep responses concise. Do not invent APIs. Current date: 2026-09-22. Working directory: /Users/nikita/Desktop/Projects/otis. Skills available: none. Output capabilities: mermaid diagrams are rendered natively.`,
  python: `def kv_cache_bytes(groups, context_length):
    total = 0
    for group in groups:
        tokens = context_length if group.window is None else min(context_length, group.window)
        per_layer = group.bytes_per_token or group.kv_heads * group.head_dim * 4
        total += group.layers * per_layer * tokens
    return total


class Fit:
    def __init__(self, model, available, context_length):
        self.model = model
        self.available = available
        self.context_length = context_length

    def __repr__(self):
        return f"Fit({self.model!r}, {self.available}, {self.context_length})"`,
  log: `2026-09-22T11:45:03.118Z INFO  server listening on http://127.0.0.1:8080
2026-09-22T11:45:03.137Z INFO  load_model: loading model '/models/Qwen3.8-27B-Q4_K_M.gguf'
2026-09-22T11:45:04.902Z INFO  llama_model_loader: loaded meta data with 38 key-value pairs and 771 tensors
2026-09-22T11:45:04.903Z INFO  print_info: n_ctx_train = 262144, n_embd = 5120, n_layer = 64
2026-09-22T11:45:05.211Z WARN  fit: reducing context from 262144 to 193536 to fit 31 GiB
2026-09-22T11:45:09.870Z INFO  llama_kv_cache: Metal KV buffer size = 12096.00 MiB
2026-09-22T11:45:09.871Z INFO  llama_context: Metal compute buffer size = 1104.00 MiB
2026-09-22T11:45:09.872Z INFO  main: model loaded in 6.7 s`,
  russian: `Оценка памяти для локального вывода складывается из трёх частей: файлов весов модели, кэша ключей и значений, а также вычислительных буферов, которые выделяет среда выполнения. При выборе модели Otis сначала вычисляет максимальную длину контекста, которая помещается в обнаруженное оборудование, а затем резервирует часть памяти для операционной системы и других приложений.`,
  french: `L'estimation de la mémoire pour l'inférence locale comprend trois parties : les fichiers de poids du modèle, le cache clé-valeur et les tampons de calcul alloués par l'environnement d'exécution. Lors du choix d'un modèle, Otis calcule d'abord la longueur de contexte maximale qui tient dans le matériel détecté, puis réserve une partie de la mémoire pour le système d'exploitation et les autres applications. Größere Modelle brauchen natürlich mehr Speicher, aber die Schätzung bleibt gleich.`,
  emoji: `Deploy done ✅ 🚀 — all 12 checks passed 🎉. Next up: 🔧 fix the footer, 📱 test on mobile, 🧪 add a regression test. Ping me if anything looks off 👀`,
}

const SAMPLE_TOKENS = {
  qwen2: {
    casual: 108,
    markdown: 123,
    system: 112,
    python: 140,
    log: 382,
    russian: 112,
    french: 126,
    emoji: 50,
  },
  llama3: {
    casual: 108,
    markdown: 123,
    system: 108,
    python: 140,
    log: 279,
    russian: 105,
    french: 128,
    emoji: 49,
  },
  lfm25: {
    casual: 108,
    markdown: 126,
    system: 110,
    python: 148,
    log: 294,
    russian: 112,
    french: 107,
    emoji: 47,
  },
} as const

const oldEstimate = (text: string) => Math.ceil(text.length / 4)

describe("text token estimate", () => {
  it.each(
    Object.keys(CORPUS) as (keyof typeof CORPUS)[],
  )("estimates %s within 15% of every reference tokenizer", (name) => {
    const estimate = Math.ceil(estimateTextTokens(CORPUS[name]))
    for (const reference of Object.values(REFERENCE_TOKENS)) {
      expect(Math.abs(estimate / reference[name] - 1)).toBeLessThanOrEqual(0.15)
    }
  })

  it("is closer than chars/4 on the whole corpus and on every class chars/4 misses", () => {
    for (const reference of Object.values(REFERENCE_TOKENS)) {
      let newError = 0
      let oldError = 0
      for (const name of Object.keys(CORPUS) as (keyof typeof CORPUS)[]) {
        const estimate = Math.ceil(estimateTextTokens(CORPUS[name]))
        const oldRelative = Math.abs(oldEstimate(CORPUS[name]) / reference[name] - 1)
        const newRelative = Math.abs(estimate / reference[name] - 1)
        if (oldRelative > 0.15) expect(newRelative).toBeLessThan(oldRelative)
        newError += Math.abs(estimate - reference[name])
        oldError += Math.abs(oldEstimate(CORPUS[name]) - reference[name])
      }
      expect(newError).toBeLessThan(oldError)
    }
  })

  it("stays within a quarter of the references on mixed and non-ASCII samples", () => {
    for (const name of Object.keys(SAMPLES) as (keyof typeof SAMPLES)[]) {
      const estimate = Math.ceil(estimateTextTokens(SAMPLES[name]))
      for (const reference of Object.values(SAMPLE_TOKENS)) {
        expect(Math.abs(estimate / reference[name] - 1), name).toBeLessThanOrEqual(0.25)
      }
    }
  })

  it("is pure, additive, and cheap on long input", () => {
    expect(estimateTextTokens("")).toBe(0)
    const parts = [CORPUS.prose, CORPUS.json, CORPUS.cjk]
    expect(estimateTextTokens(parts.join(""))).toBeCloseTo(
      parts.reduce((sum, part) => sum + estimateTextTokens(part), 0),
      6,
    )
    const long = CORPUS.typescript.repeat(2_000)
    const started = performance.now()
    estimateTextTokens(long)
    expect(performance.now() - started).toBeLessThan(500)
  })
})
