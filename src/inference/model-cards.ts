/**
 * Curated model cards for the managed-local catalog, shown beside the desktop picker. Every claim
 * traces to the author's Hugging Face model card or the author's own published measurements; Otis
 * ranks nothing itself. This module stays free of Node imports so the renderer can read it.
 */
export type LocalModelCard = {
  author: string
  /** One sentence: lineage, size, modality, context. */
  summary: string
  bestAt: readonly string[]
  worstAt: readonly string[]
  /** The author's model card. */
  source: string
}

const HF = "https://huggingface.co/"

export const LOCAL_MODEL_CARDS: Readonly<Record<string, LocalModelCard>> = {
  "ornith-ai/Ornith-1.5-9B": {
    author: "Ornith AI",
    summary:
      "The lightest Ornith 1.5 model: 9B dense weights built for a single GPU, with image input " +
      "and a 256K context.",
    bestAt: [
      "Agentic coding, which Ornith evaluates in the OpenHands and Claude Code harnesses",
      "Tool use inside agent harnesses, measured on Toolathlon and MCP-Atlas",
      "Image input in a 9B footprint that fits 12 GiB cards and 16 GiB Macs",
    ],
    worstAt: [
      "Hard reasoning, where the 27B-class models in this catalog have more headroom",
      "Thinking is on or off only, with no effort levels",
    ],
    source: `${HF}ornith-ai/Ornith-1.5-9B`,
  },
  "google/gemma-4-12B-it": {
    author: "Google DeepMind",
    summary:
      "12B dense Gemma 4 with text and image input, a 256K context, and Google's own " +
      "quantization-aware 4-bit weights.",
    bestAt: [
      "Coding and agent tasks with native function calling, which Google highlights for Gemma 4",
      "Image understanding and multilingual text",
      "Near full-precision quality at 4 bits, since Google trained the quantized weights",
    ],
    worstAt: [
      "Hard reasoning, where the 26B and 31B Gemma siblings have more headroom",
      "Thinking is on or off only, with no effort levels",
      "Audio input, which the checkpoint supports but Otis does not send",
    ],
    source: `${HF}google/gemma-4-12B-it`,
  },
  "LiquidAI/LFM2.5-2.6B": {
    author: "Liquid AI",
    summary: "2.6B hybrid model built for on-device agents, text only, with a 128K context.",
    bestAt: [
      "Tool use and multi-step agent tasks for its size: Liquid reports results competitive " +
        "with models four times larger",
      "Data extraction, retrieval-augmented answers, and long-context work",
      "Fits almost any machine and answers quickly",
    ],
    worstAt: [
      "Agentic coding, which Liquid does not recommend it for",
      "Knowledge-heavy questions without retrieval or web search",
      "No image input",
    ],
    source: `${HF}LiquidAI/LFM2.5-2.6B`,
  },
  "LiquidAI/LFM2.5-24B-A2B": {
    author: "Liquid AI",
    summary:
      "24B mixture of experts with 2B active per token that always reasons before answering, " +
      "text only, with a 128K context.",
    bestAt: [
      "Agents that reason and call tools: Liquid reports it ahead of Qwen3.6-35B-A3B on its " +
        "agentic and tool-use benchmarks",
      "Fast generation for its size, since only 2B parameters run per token",
      "Instruction following and chat across 16 languages",
    ],
    worstAt: [
      "Knowledge-heavy tasks on its own; Liquid suggests pairing it with retrieval or web search",
      "Short answers, since thinking cannot be turned off",
      "No image input",
    ],
    source: `${HF}LiquidAI/LFM2.5-24B-A2B`,
  },
  "Qwen/Qwen3.8-27B": {
    author: "Qwen",
    summary:
      "Dense 27B with a vision encoder and a 256K context; the full-precision model that Saluki " +
      "and Bonsai are cut from.",
    bestAt: [
      "Coding and long-horizon agent work, where Qwen reports its largest gains",
      "Image, document, and diagram understanding",
      "Thinking depth you can tune per request, from off to extra high",
    ],
    worstAt: [
      "Memory: about 23 GiB at a 64K context, so it needs a larger GPU or Mac",
      "CPU-only machines, where a dense 27B model reads every weight for each token",
      "Download size, the largest of the mid-size models at 19.6 GB",
    ],
    source: `${HF}Qwen/Qwen3.8-27B`,
  },
  "prism-ml/Ternary-Bonsai-2-27B-gguf": {
    author: "Prism",
    summary:
      "Qwen3.8-27B in ternary weights at 1.7 bits per weight, 5.9 GB, with an optional vision " +
      "tower; runs on Prism's llama.cpp fork, which Otis manages.",
    bestAt: [
      "The smallest 27B-class footprint in the catalog; Prism reports 98 percent of " +
        "full-precision scores across 14 thinking benchmarks",
      "Math and coding close to the full model in Prism's measurements",
      "Image input through the optional vision tower",
    ],
    worstAt: [
      "Tool calling trails Saluki in Underdog's benchmark, 70 of 120 tasks against 88",
      "Low thinking effort is not supported; the model behaves like extra high",
      "Vulkan GPUs get only the smaller PTQ1 packing",
    ],
    source: `${HF}prism-ml/Ternary-Bonsai-2-27B-gguf`,
  },
  "ConwayResearch/Underdog-Saluki-27B-1.0": {
    author: "Underdog",
    summary:
      "Qwen3.8-27B cut to 2-bit mixed precision in 7.9 GB, tuned to keep tool calling intact, " +
      "with an optional vision projector and a 256K context.",
    bestAt: [
      "Tool calling at full-model level: Underdog reports 88 of 120 tasks against 84 for the " +
        "54 GB original on its frozen BFCL subset",
      "Parallel tool calls and instruction following",
      "27B-class capability in the memory of a 9B model",
    ],
    worstAt: [
      "Competition math, keeping roughly 82 to 85 percent of the full model's score",
      "Letter-level puzzles such as palindromes and alphabetical ordering",
      "Long reasoning before answering with thinking on, and small formatting slips in about " +
        "one parallel-call reply in five",
    ],
    source: `${HF}ConwayResearch/Underdog-Saluki-27B-1.0`,
  },
  "Qwen/Qwen3.8-Flash-Next": {
    author: "Qwen",
    summary:
      "Experimental preview of the Qwen4 architecture: a 512-expert mixture with 11 active, " +
      "sparse attention, a vision encoder, and a 256K context.",
    bestAt: [
      "Agentic coding and real-world tool use, which Qwen reports on SWE-bench and Toolathlon",
      "Fast generation for a model this large, thanks to sparse attention and few active experts",
      "Image input",
    ],
    worstAt: [
      "Memory: an 82 GB download that needs a 96 GiB class GPU or a 128 GiB Mac",
      "Stability, since Qwen labels the architecture an experimental preview",
      "Fidelity below 192 GiB, where Otis uses a third-party IQ3 conversion instead of Qwen's Q8",
    ],
    source: `${HF}Qwen/Qwen3.8-Flash-Next`,
  },
  "openai/gpt-oss-20b": {
    author: "OpenAI",
    summary:
      "21B mixture of experts with 3.6B active, text only, with a 128K context and OpenAI's " +
      "published MXFP4 weights.",
    bestAt: [
      "Agent tasks and tool use, which OpenAI calls out, with low, medium, and high effort",
      "Low latency on modest hardware, OpenAI's stated target for the 20B size",
      "Debugging, since the full chain of thought is exposed",
    ],
    worstAt: [
      "No image input",
      "Showing its reasoning to end users, which OpenAI advises against",
      "High-reasoning work, where OpenAI points to the 120B sibling instead",
    ],
    source: `${HF}openai/gpt-oss-20b`,
  },
  "google/gemma-4-26B-A4B-it": {
    author: "Google DeepMind",
    summary:
      "26B Gemma 4 mixture of experts with 4B active per token, text and image input, and a " +
      "256K context.",
    bestAt: [
      "Fast generation for its size, since 4B parameters run per token",
      "Coding, reasoning, and function calling in Google's workstation tier",
      "Image input",
    ],
    worstAt: [
      "Memory: about 17 GiB at a 64K context, since every expert stays loaded",
      "Thinking is on or off only, with no effort levels",
      "Audio input, which the checkpoint supports but Otis does not send",
    ],
    source: `${HF}google/gemma-4-26B-A4B-it`,
  },
  "google/gemma-4-31B-it": {
    author: "Google DeepMind",
    summary:
      "31B dense Gemma 4, the largest of the family, with text and image input and a 256K " +
      "context.",
    bestAt: [
      "The strongest Gemma for coding, reasoning, and agents",
      "Image understanding",
      "Multilingual text",
    ],
    worstAt: [
      "Memory and speed: the most of the Gemma family, and the slowest per token",
      "Thinking is on or off only, with no effort levels",
      "Audio input, which the checkpoint supports but Otis does not send",
    ],
    source: `${HF}google/gemma-4-31B-it`,
  },
  "zai-org/GLM-5.3": {
    author: "Z.ai",
    summary:
      "Frontier-scale mixture of experts with a 1M context and reasoning effort of low, high, " +
      "or max; a 343 GB download.",
    bestAt: [
      "Agentic engineering: Z.ai reports results on Terminal-Bench, DeepSWE, and Toolathlon",
      "Very long context work, up to 1M tokens",
      "Deep reasoning at max effort",
    ],
    worstAt: [
      "Memory: about 384 GiB of GPU or unified memory, so only the largest machines run it",
      "No image input",
      "Latency at the default max effort; set low for chat",
    ],
    source: `${HF}zai-org/GLM-5.3`,
  },
}

export function localModelCard(modelId: string): LocalModelCard | undefined {
  return Object.hasOwn(LOCAL_MODEL_CARDS, modelId) ? LOCAL_MODEL_CARDS[modelId] : undefined
}
