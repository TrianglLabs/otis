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
fit the detected system with at least a 64K context window. An `*` marks the model recommended for the detected system
memory.

Selecting a model downloads:

- an Otis-pinned `llama-server` build for the current platform; and
- a revision-pinned GGUF, or its required split GGUF files, from Hugging Face.

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

When at least one GGUF is cached, open **Settings → Local models** to delete it. Otis only deletes files from its own
model cache.

- Deleting an inactive model does not interrupt the active server.
- Deleting the active model stops `llama-server` and clears the selection.
- Deleting the final downloaded model also stops the managed server.

For implementation details, see the [local llama.cpp boundary](architecture.md#local-llamacpp-boundary).
