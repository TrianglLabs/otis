# Managed local inference

Otis can download and run a curated GGUF model on the same computer as the terminal interface. This path is managed
entirely by Otis and does not require a Fireworks API key, Ollama, LM Studio, or NVIDIA PAIR.

## Requirements

Managed local inference supports macOS and Linux on arm64 and x64. For a good experience, use:

- Apple silicon with at least 24 GB of unified memory; or
- Linux with at least 24 GB of RAM. A Vulkan-capable GPU improves speed, and 16 GB or more of VRAM is recommended.

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

For Bonsai 2, Otis also selects the packing automatically. It uses the 5.95 GB `PTQ1_0` packing with up to 8 GiB of
dedicated VRAM or 16 GiB of unified/system memory, then uses the 7.21 GB `PQ2_0` packing on larger hardware when the
backend supports it. Linux GPU inference currently keeps `PTQ1_0` at every VRAM size because Otis' pinned Vulkan
runtime lacks PQ2 kernels. Macs above 16 GiB use `PQ2_0`. The picker displays the packing selected for the current machine.

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
