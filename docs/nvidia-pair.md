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
3. In Otis, choose **Local inference → Local servers** during setup, or open **Settings → Local servers**.
4. Enter at least one endpoint, then continue to the normal model picker. No token entry is required in Otis.

Local agent use requires at least **65,536 tokens (64K)** of configured context in the server. For PAIR, configure
every eligible node to meet that minimum. Otis does not resize or manage the servers.

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
compaction state. Otis uses its 65,536-token minimum as the working budget, starting compaction at 80% of that
budget. This is a product requirement and fallback policy, not a verified server allocation. Selection does not
certify that every PAIR node meets it. If a runtime context-overflow error reports a smaller serving limit, Otis
stops with an instruction to increase server context. Other explicit input overflows trigger bounded compaction
and retry for the current turn. Otis never learns a cluster-wide limit from one routed response or metadata route.

Selecting a model records its engine and model ID, then resolves the corresponding endpoint when inference begins. It
does not send a preflight chat request. If the model cannot produce compatible tool calls, that limitation appears
during the conversation rather than during selection.

Ollama requests use `/api/chat` with `truncate: false` and `shift: false` so compatible servers reject an oversized
request instead of silently removing history. Use an Ollama version that supports these controls on every routed
node. LM Studio uses `/v1/chat/completions`; configure its context overflow policy to stop at the limit. Otis can
compact and retry explicit input-overflow errors, but cannot recover information a server silently discards.
For these external servers, token counts before inference remain estimates corrected by returned usage.

## PAIR versus This machine

The two local paths are independent:

- **This machine** downloads a curated GGUF and runs an Otis-managed `llama-server` process.
- **NVIDIA PAIR** uses models already managed by Ollama or LM Studio across the PAIR cluster.

Switching to PAIR stops an active Otis-managed server. Switching back starts the managed-local process again when
needed. Otis never installs PAIR, downloads models into its engines, or controls its cluster.

For the exact transport and persistence boundaries, see the [PAIR architecture](architecture.md#nvidia-pair-boundary).
