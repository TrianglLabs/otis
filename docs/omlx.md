# oMLX

[oMLX](https://github.com/jundot/omlx) runs MLX models on Apple Silicon and exposes a local OpenAI-compatible API.
Otis connects to that API while continuing to own conversations, tools, permissions, subagents, and sessions.
Install and manage oMLX separately; Otis does not install it, download its models, or start and stop its server.

## Connect

1. Start oMLX and install a model with tool-calling support.
2. In Otis, choose **Local inference → Local servers**, or **Settings → Local servers** in the terminal
   (**Settings → Inference → Local model servers** in the desktop app).
3. Enter `http://127.0.0.1:8000` in the **oMLX** field, adjusting the port if needed. A trailing `/v1` is also accepted.
4. If oMLX requires authentication, enter its API key. Otherwise leave the key blank.
5. Connect, then choose a model from the **oMLX** section of the model picker.

Only one working server is required. Other local servers can remain configured alongside oMLX. The oMLX field
connects directly to oMLX; the Ollama and LM Studio fields can connect directly or to NVIDIA PAIR's matching proxies.
All endpoints must use HTTP on loopback (`127.0.0.1`, `localhost`, or `::1`).

An oMLX key is saved only in Otis's private local configuration and sent as a bearer header. It is not included in
model content, session metadata, model-picker entries, or desktop status. Reconnecting to the same address with a
blank key preserves the saved key. Changing the address requires entering its key again. To forget the oMLX
connection and its key, clear its endpoint and connect another available server.

After selection, `otis exec --ephemeral "your prompt"` uses the saved oMLX model without a Fireworks key.

## Discovery and context

Otis reads `/v1/models` for the visible model IDs, including aliases and exposed profiles. It optionally reads
`/v1/models/status` for model type and vision support, excluding reported embedding, reranking, and audio-only
models. Older servers without status remain usable, with vision disabled when it cannot be verified. Neither
discovery nor selection sends a preflight inference request or calls model load/unload endpoints.

The reported `max_model_len` (or status `max_context_window`) controls compaction. This is the server's configured
request limit, not a guarantee that the model and its entire context fit in memory. Otis refreshes it at startup
and reconnect. If no valid limit is reported, Otis uses an internal 8K compaction guard without displaying that
fallback as server metadata. PAIR's architecture-maximum metadata rules remain separate.

Requests reuse Otis's OpenAI-compatible streaming transport and preserve reasoning and tool-call history.
oMLX controls its own sampling and thinking defaults; Otis does not send llama.cpp template parameters or Fireworks
reasoning settings. oMLX's batched server can receive Otis subagent requests concurrently; available memory and
model quality still determine practical performance. Tool execution remains in Otis.

API compatibility does not guarantee reliable tool calling for every checkpoint. The selected model's chat template
and oMLX's parser must support its tool-call format. Otis does not claim to have verified every user-installed model.
