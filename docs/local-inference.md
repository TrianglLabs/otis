# Managed local inference

Otis can download and run a curated GGUF model on the same computer as the terminal interface. This path is managed
entirely by Otis and does not require a Fireworks API key, Ollama, LM Studio, or NVIDIA PAIR.

## Requirements

Managed local inference supports macOS and Linux on arm64 and x64. For a good experience, use:

- Apple silicon with at least 24 GB of unified memory; or
- Linux with at least 24 GB of RAM. A CUDA- or Vulkan-capable GPU improves speed, and 16 GB or more of VRAM is recommended.

CPU-only inference remains available on supported systems, but it is slower. On Linux, llama.cpp can split a model
between GPU memory and system RAM, so the complete model does not need to fit in VRAM. Integrated graphics (AMD APUs
such as Strix Halo, Intel iGPUs) share system RAM and are budgeted from it, like Apple unified memory.

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

Otis also retries with Vulkan if the CUDA server exits during model loading with a recognizable CUDA backend
error. Fallback runs strictly CUDA, then Vulkan, then the CPU build: when Vulkan reports no device or exits with a
recognizable Vulkan error, Otis loads the model on the pinned CPU runtime and reports why, including the CUDA and
Vulkan causes. Download or checksum failures, cancellation, and unrelated model errors do not trigger a backend
switch. CPU-only machines still use the CPU runtime directly.

Existing CUDA toolkit and driver installations are left untouched. Libraries stay in Otis's own data directory. For
managed Linux servers and their device checks, Otis puts the bundle first in the child process's library search path,
preserving the remaining paths for system, container, and WSL drivers. It removes inherited library preloads, loader
auditing, and external ggml backend overrides from that child only. The server and its device probe receive only an
allowlist of the parent environment: `PATH`, `HOME`, temporary directories, locale, loader paths (`LD_*`, and `DYLD_*`
on macOS), GPU visibility (`CUDA_*`, `NVIDIA_*`, `GGML_*`, `VK_*`, `MTL_*`), and display settings. Hugging Face tokens
and provider keys never reach the server. A custom `OTIS_LLAMA_SERVER` retains its loader settings and bypasses
automatic backend selection.

After updating Otis, the next managed model load downloads the new runtime when needed. Existing GGUF downloads and
sessions are retained. CUDA, Vulkan, and CPU bundles can coexist (on Linux the CPU build installs beside the others),
and obsolete runtime releases are cleaned up after the new runtime is available. Both the terminal and desktop use
this same selection and upgrade path.

Otis records its managed server (`<data>/llama/server.json`) while it runs. If Otis crashes and leaves the server
behind, the next model load stops that orphan before starting a new one; a server owned by another running Otis is
left alone. If the server dies during a session, the next request reports its exit code or signal with the last log
lines, and reselecting the model restarts it.

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
This changes model behavior independently of the thinking-trace visibility setting. The startup generation check and
conversation summaries always use the model's lowest documented thinking setting, whatever the slider says.

Qwen3.8 offers off/low/medium/xhigh, Bonsai 2 off/medium/xhigh, gpt-oss low/medium/high, and GLM-5.3 low/high/max.
Ornith and Gemma expose on/off only. LFM2.5 has no documented thinking control and does not show the slider.
The capability policy lives in `src/inference/local-thinking.ts`; it uses native template controls, not invented token
budgets. Hosted and user-managed servers keep their existing behavior. Token counting uses the same thinking
parameters as inference, and changing effort invalidates the previous observed context count.

Recommendations star the first fitting group of a curated preference order. This is an Otis default, not a benchmark
ranking. When a GPU can hold a whole model—selected weights, a 64K context cache, and runtime buffers, after
llama.cpp's 1 GiB margin per device—the order is GLM-5.3, Qwen3.8 Flash Next, Qwen3.8 27B, Bonsai 2 27B,
Ornith 1.5 9B / Gemma 4 12B, then LFM2.5 2.6B. A GPU-resident fit does not need host RAM for its layers, so extra
system RAM alone does not promote a larger model and little system RAM does not hide one. Without such a GPU—CPU-only
hosts, GPUs whose VRAM is unreported, and GPUs too small to hold any model whole—generation is bound by host memory
bandwidth, and the order prefers mixtures of experts with few active parameters and small dense models: Qwen3.8 Flash
Next, gpt-oss 20B / Gemma 4 26B A4B, Ornith 1.5 9B / Gemma 4 12B, then LFM2.5 2.6B. Candidates there must fit host
memory with at least a 64K context, and the star may land on a row that spills layers to the CPU. Models whose 64K
footprint exceeds the GPU budget but fits GPU plus host memory remain selectable, show an estimated 64K context and
a CPU marker (`◐` in the terminal, a chip icon in the desktop), and are not starred while a GPU-resident candidate exists.

Examples with a dedicated GPU:

| Dedicated VRAM | Recommended model |
| --- | --- |
| 4 GiB | Qwen3.8 Flash Next when host RAM holds it, else the CPU order |
| 6–8 GiB | LFM2.5 2.6B |
| 12 GiB | Ornith 1.5 9B / Gemma 4 12B |
| 16–24 GiB | Bonsai 2 27B |
| 32–80 GiB | Qwen3.8 27B |
| 96–256 GiB | Qwen3.8 Flash Next |
| 384 GiB and above | GLM-5.3 |

On Apple silicon, Metal can wire at most the GPU working set (`recommendedMaxWorkingSetSize`): about two thirds of
unified memory up to 36 GiB and three quarters above. Otis models that working set, reserves llama.cpp's 1 GiB margin
inside it, and stars only models that hold 64K there; the rest of memory stays with the system. With the default
working set:

| Unified memory | Recommended model |
| --- | --- |
| 8 GiB | LFM2.5 2.6B |
| 16–18 GiB | Ornith 1.5 9B / Gemma 4 12B |
| 24–36 GiB | Bonsai 2 27B |
| 48–96 GiB | Qwen3.8 27B |
| 128–384 GiB | Qwen3.8 Flash Next |
| 512 GiB | GLM-5.3 |

The working set can be raised with `sudo sysctl iogpu.wired_limit_mb=<MiB>` (it resets at reboot); Otis reads that
value at startup and budgets against it. Leave the system a few GiB: for example `26624` lets a 36 GiB Mac star
Qwen3.8 27B, `86016` lets a 96 GiB Mac star Qwen3.8 Flash Next, and `344064` lets a 384 GiB Mac star GLM-5.3.
These are examples, not hard tier boundaries: exact artifact sizes and detected memory determine fit. Smaller systems
fall back to smaller fitting models, and larger systems have no artificial upper cutoff. CPU-only systems follow the
host-bandwidth order above; this is not a throughput guarantee.

Local rows list starred models first, then the rest of the preference order, then the remaining catalog.

Otis checks that the cache volume has room for the remaining bytes before a download starts, counting cached and
partial files, and fails early with the needed and available sizes otherwise. It verifies the pinned size and checksum
of every completed artifact. Interrupted model downloads resume from a partial file, but the final files must still
pass verification. A download lock that its holder stops refreshing expires after a minute, so a crashed download
never blocks the next one. The picker shows download progress and marks cached models as `Downloaded`.

The managed server listens only on `127.0.0.1`. Otis starts it with llama.cpp's Jinja chat-template support and keeps
tool execution in the Otis runtime instead of enabling llama.cpp's built-in tools.

## Context and memory estimates

For a model that is not running, the picker labels its calculated context as `Est.`. The `memory` figure is the
estimated use: the selected GGUF files, the model's KV cache at that context, and 1.5 GiB for runtime buffers. Otis
separately reserves 15% of Apple unified memory (at least 3 GiB) or 10% of other system RAM (at least 2 GiB) for the
host, and 1 GiB per GPU—llama.cpp's default `--fit-target`—inside the GPU budget. Unified memory is one pool; Otis
does not add it twice as RAM and VRAM, and a Mac's GPU budget is the Metal working set less that margin. A dedicated
GPU holds a GPU-resident model on its own; a model that spills layers must fit GPU plus host memory. These are capacity
estimates, not a guarantee against other applications consuming memory.

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
