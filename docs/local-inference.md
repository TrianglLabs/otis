# Managed local inference

Otis can download and run a curated GGUF model on the same computer as the terminal interface. This path is managed
entirely by Otis and does not require a Fireworks API key, Ollama, LM Studio, or NVIDIA PAIR.

## Requirements

Managed local inference supports macOS and Linux on arm64 and x64. For a good experience, use:

- Apple silicon with at least 24 GB of unified memory; or
- Linux with at least 24 GB of RAM. A CUDA- or Vulkan-capable GPU improves speed, and 16 GB or more of VRAM is recommended.

CPU-only inference remains available on supported systems, but it is slower. On Linux, llama.cpp can split a model
between GPU memory and system RAM, so the complete model does not need to fit in VRAM.

On unsupported platforms, managed models appear unavailable before any download begins.

## Select and download a model

Choose **Local inference → This machine** during setup, or open `/model` later. Otis shows only curated models that can
fit the detected system with at least a 64K context window. An `*` marks a recommended model for the detected hardware.
The terminal and desktop use the same recommendation policy.

Selecting a model downloads:

- an Otis-pinned `llama-server` build for the current platform; and
- a revision-pinned GGUF, or its required split GGUF files, from Hugging Face.

Most models use Otis' pinned upstream llama.cpp build. Bonsai 2 uses a separately pinned Prism llama.cpp build because
its ternary GGUFs need Prism's loader and compute kernels. Otis selects that runtime from the model catalog; it
does not replace the upstream runtime used by other models.

On Linux, compatible NVIDIA GPUs use the official upstream CUDA builds and their matching CUDA runtime/cuBLAS
libraries. Otis downloads both; installing the CUDA toolkit is not required. The system still needs an NVIDIA driver
and the normal Linux runtime libraries, including OpenMP (`libgomp1` on Ubuntu).

CUDA selection requires glibc 2.39 or newer. CUDA 12.8 is available on x64 with NVIDIA driver 570.211.01 or newer and
GPU compute capability 5.0–12.0. CUDA 13.3 is preferred on x64 and arm64 with driver 610.43.02 or newer and compute
capability 7.5–12.1. All detected NVIDIA GPUs must be compatible with the selected build. Unknown or incompatible
configurations keep Vulkan, as do AMD and Intel GPUs. Otis also checks that the downloaded CUDA server can see a CUDA
device before loading a model; if it cannot, it uses Vulkan. Bonsai uses Prism's official CUDA binaries on Linux x64,
paired with the same-version NVIDIA runtime/cuBLAS libraries from the pinned upstream companion archives. Prism does
not publish a Linux arm64 CUDA binary, so Bonsai keeps Vulkan there.

Otis also retries once with Vulkan if the CUDA server exits during model loading with a recognizable CUDA backend
error. Vulkan must report an available device before it is used; if it cannot, Otis reports a load error. Download or
checksum failures, cancellation, and unrelated model errors do not trigger a backend switch. CPU-only machines still
use the CPU runtime directly.

Existing CUDA toolkit and driver installations are left untouched. Libraries stay in Otis's own data directory. For
managed Linux servers and their device checks, Otis puts the bundle first in the child process's library search path,
preserving the remaining paths for system, container, and WSL drivers. It removes inherited library preloads, loader
auditing, and external ggml backend overrides from that child only. GPU visibility settings and the parent environment
are preserved. A custom `OTIS_LLAMA_SERVER` retains its loader settings and bypasses automatic backend selection.

After updating Otis, the next managed model load downloads the new runtime when needed. Existing GGUF downloads and
sessions are retained. CUDA and Vulkan bundles can coexist, and obsolete runtime releases are cleaned up after the new
runtime is available. Both the terminal and desktop use this same selection and upgrade path.

For Bonsai 2, Otis also selects the packing automatically. It uses the 5.95 GB `PTQ1_0` packing with up to 8 GiB of
dedicated VRAM or 16 GiB of unified/system memory, then uses the 7.21 GB `PQ2_0` packing on larger hardware when the
backend supports it. CUDA systems whose detected GPUs are all Ada (compute capability 8.9, including RTX 40-series,
L4, and L40) keep `PTQ1_0` for its faster generation in [Prism's measurements](https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf#cross-platform-throughput).
Other CUDA systems above the compact-memory tier use `PQ2_0` for faster prompt processing; this includes mixed or
unknown GPU architectures. Macs above 16 GiB also use `PQ2_0`. Vulkan requires `PTQ1_0` because the pinned runtime
lacks PQ2 kernels. If CUDA falls back to Vulkan, Otis reselects PTQ1 and downloads it only if needed, retaining any
cached PQ2 file. A failure during the fallback download is reported without starting incompatible weights.
The picker displays the packing preferred for the detected hardware; runtime fallback may use the compact packing.

Managed local models with documented thinking controls show a **Thinking** slider beside the desktop model picker.
The terminal uses `/effort` to list supported values and `/effort medium` (for example) to select one.
Preferences are saved per model in the private local config; `/effort default` or **Use model default** removes the
override. Changes apply to subsequent requests without restarting the model. Controls are unavailable during a turn.
This changes model behavior independently of the thinking-trace visibility setting.

Qwen3.8 offers off/low/medium/xhigh, Bonsai 2 off/medium/xhigh, gpt-oss low/medium/high, and GLM-5.3 low/high/max.
Ornith and Gemma expose on/off only. LFM2.5 has no documented thinking control and does not show the slider.
The capability policy lives in `src/inference/local-thinking.ts`; it uses native template controls, not invented token
budgets. Hosted and user-managed servers keep their existing behavior. Token counting uses the same thinking
parameters as inference, and changing effort invalidates the previous observed context count.

Recommendations choose the first fitting group in this curated preference order: GLM-5.3, Qwen3.8 Flash Next,
Qwen3.8 27B, Bonsai 2 27B, Ornith 1.5 9B / Gemma 4 12B, then LFM2.5 2.6B. This is an Otis default, not a benchmark
ranking. All candidates must fit host memory with at least a 64K context and runtime overhead. On dedicated GPUs with
known VRAM, the selected weights must also fit after reserving 1 GiB per detected GPU; extra system RAM alone does not promote
a larger model. KV cache and compute buffers may still require CPU offloading, so a star does not guarantee fully
GPU-resident inference. Unknown VRAM falls back to host-memory fit without promising GPU acceleration; the runtime
still reserves 1 GiB per GPU rather than deriving a GPU margin from host RAM.

Examples with enough host RAM:

| Dedicated VRAM | Recommended model |
| --- | --- |
| 8–16 GiB | Bonsai 2 27B |
| 24–64 GiB | Qwen3.8 27B |
| 80–256 GiB | Qwen3.8 Flash Next |
| 384 GiB and above | GLM-5.3 |

Macs with 16–24 GiB unified memory recommend Bonsai, 32–64 GiB recommend Qwen3.8 27B, 96–256 GiB recommend
Qwen3.8 Flash Next, and 384 GiB or more recommend GLM-5.3. These are examples, not hard tier boundaries: exact artifact
sizes and detected memory determine fit. Smaller systems fall back to smaller fitting models, and larger systems have
no artificial upper cutoff. CPU-only systems follow the same host-fit preferences; this is not a throughput guarantee.

Otis verifies the pinned size and checksum of every completed artifact. Interrupted model downloads resume from a
partial file, but the final files must still pass verification. The picker shows download progress and marks cached
models as `Downloaded`.

The managed server listens only on `127.0.0.1`. Otis starts it with llama.cpp's Jinja chat-template support and keeps
tool execution in the Otis runtime instead of enabling llama.cpp's built-in tools.

## Context and memory estimates

For a model that is not running, the picker labels its calculated context as `Est.`. The estimate includes a
conservative memory reserve for the operating system and runtime buffers.

At startup, llama.cpp performs the authoritative fit and chooses the actual context and GPU offload. Otis reads the
loaded context from the server and labels it `loaded` for the active model. On Linux with a discrete GPU, layers that
do not fit in VRAM may remain in system RAM.

This distinction matters: the estimated context helps choose a model before launch, while the loaded context controls
the active session's context meter and compaction behavior.

## Delete downloaded models

When at least one GGUF is cached, delete it from the model catalog: open the catalog from the composer's model chip
in the desktop app, or choose **Delete local model** under `/settings` in the terminal. Otis only deletes files
from its own model cache.

- Deleting an inactive model does not interrupt the active server.
- Deleting the active model stops `llama-server` and clears the selection.
- Deleting the final downloaded model also stops the managed server.

For implementation details, see the [local llama.cpp boundary](architecture.md#local-llamacpp-boundary).
