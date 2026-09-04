# NVIDIA PAIR

[NVIDIA Personal AI Router (PAIR)](https://github.com/NVIDIA/Personal-AI-Router) is a separate application that routes
local inference across computers on your network. Otis connects to PAIR's loopback proxies while continuing to own the
conversation, tools, permissions, compaction, and session history.

PAIR does not replace Otis or split one request across several computers. It sends each complete inference request to
one eligible Ollama or LM Studio engine. A computer can participate for a selected model only when that model is
available to the corresponding engine on that computer.

## Connect PAIR

1. Install and configure PAIR using [NVIDIA's setup guide](https://github.com/NVIDIA/Personal-AI-Router/blob/main/docs/getting-started.mdx).
2. In PAIR, open **Endpoints**.
3. In Otis, choose **Local inference → NVIDIA PAIR** during setup, or open **Settings → NVIDIA PAIR**.
4. Enter at least one endpoint and continue to the normal model picker.

Otis provides separate fields for the two PAIR proxies and pre-fills their standard addresses:

| Engine | Standard address | Inventory route |
| --- | --- | --- |
| Ollama | `http://127.0.0.1:11434` | `/api/tags` |
| LM Studio | `http://127.0.0.1:1234` | `/v1/models` |

Replace an address when PAIR's Endpoints window shows a custom port. Only one working endpoint is required. Otis
checks each configured engine independently and keeps every reachable inventory in the shared `/model` picker.

For safety, Otis accepts only plaintext HTTP on `127.0.0.1`, `localhost`, or `::1`. Do not paste the address of another
cluster computer directly; PAIR owns authentication and routing between nodes.

PAIR and a compatible native model server intentionally expose the same API, so Otis cannot infer which one supplied
an address. Use the value shown in PAIR's Endpoints window when you specifically want cluster routing.

## Models and metadata

All discovered models appear in one **NVIDIA PAIR** section of `/model`. Otis reads only the two cluster-aggregated
inventory routes above. It does not query LM Studio's native `/api/v1/models` route because PAIR forwards that route to
one scheduled node rather than aggregating it.

PAIR's aggregate Ollama records can report context, quantization, and capabilities. Otis displays those exact values.
The aggregate LM Studio `/v1/models` response currently contains only model IDs, so those rows show `Context
unavailable` and `Quant unavailable`; embedding models may appear because the inventory does not identify their type.

A PAIR context value is labeled `model max`. It describes the model architecture, not the context allocated on the
node that will receive a future request. Otis therefore does not persist that value or use it as cluster-wide
compaction state. While the routed-node context is unknown, Otis uses a conservative internal compaction guard.

Selecting a model records its engine and model ID, then resolves the corresponding endpoint when inference begins. It
does not send a preflight chat request. If the model cannot produce compatible tool calls, that limitation appears
during the conversation rather than during selection.

## PAIR versus This machine

The two local paths are independent:

- **This machine** downloads a curated GGUF and runs an Otis-managed `llama-server` process.
- **NVIDIA PAIR** uses models already managed by Ollama or LM Studio across the PAIR cluster.

Switching to PAIR stops an active Otis-managed server. Switching back starts the managed-local process again when
needed. Otis never installs PAIR, downloads models into its engines, or controls its cluster.

For the exact transport and persistence boundaries, see the [PAIR architecture](architecture.md#nvidia-pair-boundary).
