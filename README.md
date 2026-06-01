# openclaw-dynamo-provider

An OpenClaw plugin that registers a `dynamo` provider backed by [Dynamo](https://github.com/ai-dynamo/dynamo)'s OpenAI-compatible endpoint, so OpenClaw can use Dynamo as a normal model:

```bash
openclaw --model dynamo/<model-id>
```

With one switch (`DYN_AGENT_TRACE=1`) it also tags every request for Dynamo's agent trace, gives each subagent its own isolated KV session, and relays tool events into the trace — all without patching OpenClaw core.

## What it does

- **Model provider** — registers `dynamo`, discovers models from `/v1/models`, and streams via OpenClaw's OpenAI-compatible path.
- **Agent context** — injects `nvext.agent_context` (session/trajectory identity) so Dynamo can attribute each LLM request in its trace.
- **Subagent KV isolation** — gives each OpenClaw subagent child its own Dynamo streaming session: opened on its first turn, pinned across turns, and freed deterministically when the agent ends.
- **Tool-event relay** — pushes tool start/end events to Dynamo over ZMQ so one trace shows LLM spans and tool spans together.

Everything but the bare model provider is gated by the `DYN_AGENT_TRACE` master switch and is off by default.

## Install

```bash
# From npm (when published)
# Add to openclaw config: "plugin": ["@nvidia/openclaw-dynamo-provider"]

# From a local checkout
cd openclaw-dynamo-provider && npm install && npm run build
# Then add to your openclaw.json:
# "plugin": ["./path/to/openclaw-dynamo-provider"]
```

## Quick start

```bash
export DYNAMO_BASE_URL=http://127.0.0.1:8000/v1
export DYNAMO_API_KEY=dummy
export DYN_AGENT_TRACE=1

openclaw --model dynamo/<model-id> -p "Reply exactly ok."
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DYNAMO_BASE_URL` | `http://127.0.0.1:8000/v1` | Dynamo endpoint root (falls back to `OPENAI_BASE_URL`). |
| `DYNAMO_API_KEY` | `dynamo-local` | Bearer token. |
| `DYN_AGENT_TRACE` | off | Master switch for agent_context, session_control, and tool relay. |
| `DYN_AGENT_SESSION_TYPE_ID` | `openclaw_coding_agent` | Session class in the trace. |
| `DYN_AGENT_SESSION_ID` | OpenClaw session id | Top-level run id. |
| `DYN_AGENT_TRAJECTORY_ID` | OpenClaw session id | Trajectory id. |
| `DYN_AGENT_PARENT_TRAJECTORY_ID` | unset | Parent trajectory for linking. |
| `DYN_AGENT_SESSION_TIMEOUT` | Dynamo default (300s) | Idle timeout for subagent sessions. |
| `DYN_AGENT_TOOL_EVENTS_ZMQ_ENDPOINT` | unset | ZMQ PULL endpoint for tool relay. |

## Subagent KV isolation

When `DYN_AGENT_TRACE=1` and this process is a subagent child (detected via `OPENCLAW_AGENT_*` or `PI_SUBAGENT_*` env vars), the provider drives session lifecycle:

1. **First turn** — `session_control: {action: "open"}` — worker holds KV in a dedicated slot
2. **Later turns** — bare `session_id` — sticky routing, O(1) KV restore
3. **agent_end** — close request frees the KV deterministically

The lead agent is never pinned — only subagents get a session.

Requires Dynamo frontend in `--router-mode kv` and an SGLang worker with `--enable-streaming-session`.

## Architecture: zero code invasiveness

This plugin uses OpenClaw's standard plugin SDK:

| Feature | OpenClaw API used |
| --- | --- |
| Model provider | `api.registerProvider()` |
| Request body injection | `wrapStreamFn` hook |
| Request headers | `resolveTransportTurnState` hook |
| Session close on agent end | `api.on("agent_end")` |
| Session close on shutdown | `api.on("session_end")` |
| Tool event relay | `api.on("tool_execution_start/end")` |

No OpenClaw core changes required.

## Development

```bash
npm install
npm run check   # tsc --noEmit
npm run test    # vitest
npm run build   # -> dist/
```

## Scope

No OpenClaw core changes, no native Rust ABI. The `nvext` and `agent_trace.v1` schemas are owned upstream by Dynamo.
