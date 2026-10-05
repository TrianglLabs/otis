# User-managed servers

Otis connects to OpenAI-compatible servers you run yourself on this machine — [oMLX](https://github.com/jundot/omlx)
on Apple Silicon, and any other engine that serves `/v1/chat/completions` — while continuing to own conversations,
tools, permissions, subagents, and sessions. Install and manage the server separately; Otis does not install it,
download its models, or start and stop it. (Ollama and LM Studio connect through [NVIDIA PAIR](nvidia-pair.md).)

## Any OpenAI-compatible server

The **Custom server** field takes the address of whatever engine you run: vLLM, SGLang, llama.cpp's
`llama-server`, [NInfer](#ninfer), [Strata](#strata), or your own. It must serve `/v1/chat/completions` with
streaming and tool calls, over HTTP on loopback (`127.0.0.1`, `localhost`, or `::1`), optionally behind an API key.

Otis lists the server's models from `/v1/models` and reads each entry's `max_model_len` or `context_length` as its
request limit. Two fields cover what a server may not say:

- **Model id** — for a server with no `/v1/models`, the model name its chat completions expect. Otis then offers that
  one model.
- **Context limit** — the server's configured request limit in tokens, used for compaction when `/v1/models` does
  not report one. Local agent use requires at least 64K.

Tool calling depends on the model and the server's parser; Otis does not verify every user-installed model. Reasoning
and sampling stay at the server's defaults.

### NInfer

[NInfer](https://github.com/Neroued/ninfer) serves Qwen3.6/3.8 artifacts on one NVIDIA RTX 5090 (64-bit Linux) with
an OpenAI-compatible API that documents what it accepts. Its default address is Otis's default custom-server address,
so the setup is the defaults plus a key.

1. Start it with at least two execution lanes, so subagent turns run alongside the main conversation, and a key:

   ```bash
   ninfer-serve models/qwen3_8_27b_nvfp4.ninfer --max-context 240000 --kv-capacity 240000 \
     --max-concurrency 2 --preserve-thinking --api-key local-secret
   ```

2. In Otis, open the **Custom server** tab (desktop: **Settings → Inference → Local model servers**; terminal:
   **Settings → Local servers**). Keep `http://127.0.0.1:8080`, enter the key, and connect.
3. Choose the model from the **Custom server** section of the picker.

From another machine, run `otis serve` on the NInfer box and pair the desktop app to it; the server tab then
belongs to that machine, and NInfer stays on its loopback.

Leave **Model id** and **Context limit** blank: NInfer's `/v1/models` names its model and reports the effective
`max_model_len`, which Otis uses for compaction. It streams reasoning as `reasoning_content` and accepts both
`reasoning_content` and `reasoning` in assistant history, so sessions started on a hosted provider resume on it.
It supports function tools with `tool_choice: auto` and parallel calls, which is what Otis sends; it rejects
`strict` tools and named tool choice, which Otis does not use. `--preserve-thinking` or `--no-thinking` set the
thinking default; Otis sends no reasoning settings of its own. Checked against NInfer's `docs/serving.md`.

### Strata

[Strata](https://github.com/Niko1221/Strata) runs Qwen3.8-Flash-Next on a 12 GB+ NVIDIA or AMD card (Windows or
Linux) and serves an OpenAI-compatible API on the same default address.

1. Run Strata's setup (`START-HERE.bat` on Windows, `setup.sh` on Linux). Serving on another machine needs
   `--host` and `--api-key`; Otis connects over loopback only, so pair the desktop app to an `otis serve` daemon on
   that machine instead of exposing Strata.
2. In Otis, open the **Custom server** tab, keep `http://127.0.0.1:8080`, enter the key if you set one, and connect.
3. If Otis reports no context limit, enter the context you chose in Strata's setup (at least 65536) in **Context
   limit** and connect again. Any model id works for Strata; leave the field blank unless `/v1/models` is missing.
4. Choose the model from the **Custom server** section of the picker.

Strata's thinking level (off, low, medium, high) is set in Strata; Otis sends no reasoning settings. Strata's API
is not yet documented, so Otis has not verified how it returns reasoning or whether `/v1/models` reports a context
limit; tool calling works for the coding agents Strata lists, and Otis sends the same OpenAI tool format.

## Connect oMLX

1. Start oMLX and install a model with tool-calling support.
2. In Otis, choose **Local inference → Local servers**, or **Settings → Local servers** in the terminal
   (**Settings → Inference → Local model servers** in the desktop app).
3. Enter `http://127.0.0.1:8000` in the **oMLX** field, adjusting the port if needed. A trailing `/v1` is also accepted.
   A different engine goes in the **Custom server** field instead (default `http://127.0.0.1:8080`).
4. If oMLX requires authentication, enter its API key. Otherwise leave the key blank.
5. Connect, then choose a model from the **oMLX** section of the model picker.

Only one working server is required. Other local servers can remain configured alongside oMLX. The oMLX field
connects directly to oMLX; the Ollama and LM Studio fields can connect directly or to NVIDIA PAIR's matching proxies.
All endpoints must use HTTP on loopback (`127.0.0.1`, `localhost`, or `::1`).

A server key is saved only in Otis's private local configuration and sent as a bearer header. It is not included in
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
and reconnect. Local agent use requires at least **65,536 tokens (64K)**. Models reporting a smaller limit remain
visible but cannot be selected; increase their configured context in oMLX and reconnect. Startup and reconnect
also validate the refreshed limit before inference. If no valid limit is reported, Otis uses the 64K minimum as a
policy budget without displaying or persisting it as server metadata. PAIR's architecture-maximum metadata rules
remain separate.

Compaction reserves the fixed instructions and tools before choosing its target, so large fixed prompts are not
required to fit into half of the trigger budget. If fixed instructions or the latest prompt alone are too large,
Otis stops with an instruction to increase server context or reduce the input. Explicit oMLX prompt-overflow errors
trigger bounded compaction and retry unless they report a serving limit below 64K, which requires a server
configuration change. Memory-allocation failures do not trigger compaction. Pre-request token counts remain estimates.

Requests reuse Otis's OpenAI-compatible streaming transport and preserve reasoning and tool-call history.
oMLX controls its own sampling and thinking defaults; Otis does not send llama.cpp template parameters or Fireworks
reasoning settings. oMLX's batched server can receive Otis subagent requests concurrently; available memory and
model quality still determine practical performance. Tool execution remains in Otis.

API compatibility does not guarantee reliable tool calling for every checkpoint. The selected model's chat template
and oMLX's parser must support its tool-call format. Otis does not claim to have verified every user-installed model.
