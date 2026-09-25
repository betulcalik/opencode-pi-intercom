<div align="center">

<a href="https://github.com/betulcalik/opencode-pi-intercom">
  <img src="https://raw.githubusercontent.com/betulcalik/opencode-pi-intercom/main/docs/assets/banner.svg" alt="opencode-pi-intercom" width="860" />
</a>

[![npm version](https://img.shields.io/npm/v/opencode-pi-intercom?color=60a5fa)](https://www.npmjs.com/package/opencode-pi-intercom)
[![npm downloads](https://img.shields.io/npm/dm/opencode-pi-intercom?color=60a5fa)](https://www.npmjs.com/package/opencode-pi-intercom)
[![license](https://img.shields.io/npm/l/opencode-pi-intercom?color=22c55e)](./LICENSE)
[![tests](https://img.shields.io/badge/tests-45%2F45%20green-22c55e)](#testing)
[![OpenCode plugin](https://img.shields.io/badge/OpenCode-plugin-fbbf24)](https://opencode.ai/docs/plugins/)

### Agentic intercom between OpenCode, omp and pi sessions

Join the [omp-intercom](https://github.com/ersintarhan/omp-intercom) /
[pi-intercom](https://www.npmjs.com/package/pi-intercom) broker as a first-class
peer: OpenCode sessions appear in the same roster, receive injected prompts,
reply back, and expose an `intercom` tool to the agent — cross-agent
orchestration on one machine.

**One broker · wire-compatible protocol v1 · ask/reply threading · receipt chain · auto-reply**

[Install](#install) · [Why](#why) · [How it works](#how-it-works) · [Usage](#usage) · [Semantics](#semantics) · [Configuration](#configuration) · [Testing](#testing) · [Troubleshooting](#troubleshooting)

</div>

## Install

Works with **OpenCode V2** (`plugins` key) and **OpenCode V1 ≥ 1.18.29**
(`plugin` key) from the same package — the entrypoint default-exports both a
V2 `setup()` definition and a V1 `server()` function, and each runtime picks
its own. Requires an existing omp-intercom setup (the broker belongs to it —
this plugin reuses it and never ships its own copy).

Package: [opencode-pi-intercom on npm](https://www.npmjs.com/package/opencode-pi-intercom)

```jsonc
// OpenCode V2 — ~/.config/opencode/opencode.json(c) or .opencode/opencode.json(c)
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-pi-intercom"]
}
```

```jsonc
// OpenCode V1 (≥ 1.18.29) — same files, legacy key
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-pi-intercom"]
}
```

OpenCode bun-installs the package automatically at startup. On first instance
init the plugin connects and logs:

```
[opencode-pi-intercom] connected to broker as "opencode" (session …)
```

### V2 differences

- The `intercom` tool is registered via `ctx.tool.transform` with plain JSON
  Schema — the `@opencode-ai/plugin` helper is only used on the V1 path.
- `inboundTrigger: "never"` (context-only injection) maps to V2 **synthetic
  messages** instead of a `noReply` prompt body.
- `bridgeModel` calls `ctx.session.switchModel` before an injected prompt, so
  it **switches the session model persistently** (V1 applied it per request).
- Plugin logs go to `console` (the V2-documented path) instead of
  `client.app.log`.

## Quick start

From an omp/pi session (the other side of the bridge):

```typescript
intercom({ action: "list" })
// → • opencode-dev (9f2c3244) — ~/researches (opencode/muse-spark-1.3 · idle)

intercom({
  action: "ask",
  to: "opencode",
  message: "Refactor AuthService with retry logic — report the diff when done."
})
// → blocks until the OpenCode agent finishes and replies
```

Inside OpenCode, the agent gets the same tool:

```typescript
intercom({ action: "list" })
intercom({ action: "send", to: "planner", message: "Migration done, 3 files changed." })
intercom({ action: "ask",   to: "planner", message: "JWT or session cookies?" })
intercom({ action: "reply", message: "Session cookies — browser-first." })
intercom({ action: "status" })
```

> [!IMPORTANT]
> The broker is shared infrastructure owned by omp-intercom. This plugin
> auto-spawns it from the installed package when the socket is missing — it
> never bundles a second broker, so there is exactly one roster per machine.

## Why

Models distributed through OpenCode — e.g. Meta's Muse Spark on OpenCode Zen —
are only reachable from OpenCode clients. Delegation fixes that: an omp/pi
orchestrator sends an `ask`, OpenCode runs it with its own model and tools, and
the answer flows back over the same broker.

| Without a bridge | `opencode-pi-intercom` |
| --- | --- |
| Muse Spark unusable from omp/pi | Delegate via `ask`, answer returns |
| Copy-paste context between terminals | Structured messages with receipts |
| No cross-agent replies | `replyTo`-threaded ask/reply with timeouts |
| Per-agent tooling, no shared roster | One roster, one wire protocol |
| Manual result transcription | Auto-reply of the final assistant text |

The design principle is simple:

> **One broker. One wire protocol. Every agent a peer.**

## How it works

```text
omp session                pi session
    │                          │
    └────────────┬─────────────┘
                 ▼
          ┌────────────┐        ┌──────────────────────────────┐
          │   broker   │◄──────►│ opencode + this plugin       │
          │ (shared)   │  v1    │ register · presence · inject │
          └────────────┘        └──────────────────────────────┘
```

| Layer | Responsibility |
| --- | --- |
| **Registration** | Joins the roster with pid, cwd, live model label, and status. Duplicate peer names warn — sends stay fail-closed. |
| **Inbound** | Broker messages are acknowledged `receiver_received`, injected into the active OpenCode session as a prompt, then acknowledged `injected`. Attachments render as fenced blocks. |
| **Outbound** | The agent-facing `intercom` tool maps `send`/`ask`/`reply` onto the same wire; replies to our own asks resolve the tool call and are never re-injected. |
| **Ask / reply** | `expectsReply` + `replyTo` threading, bounded ask timeout with `cancel_ask`, mailbox redelivery for disconnected named peers. |
| **Auto-reply** | On `session.idle`, the newest assistant text is sent as the ask reply — only when it is newer than a pre-injection snapshot, so stale text never ships. |
| **Liveness** | 30 s heartbeat probes detect half-open sockets; reconnect uses bounded backoff and re-claims the same intercom session id when `stableId` is set. |

## Usage

| Surface | Behavior |
| --- | --- |
| `intercom` tool (agent) | `list` / `list-cwd` / `send` / `ask` / `reply` / `status` — mirrors the omp/pi tool so orchestration prompts read the same on both sides. |
| Prompt injection | Inbound messages arrive prefixed with `[intercom] Message from <name>`; ask messages include the exact `reply` invocation. |
| `inboundTrigger` | `always` runs the agent on every message; `replies` only for asks; `never` injects context-only (`noReply`). |
| `bridgeModel` | Force a model such as `opencode/muse-spark-1.3` on injected prompts, per request. |
| Manual peer | `PEER_NAME=dev-1 bun test/peer.ts wait` — stays registered for live checks; auto-acks asks. |

## Semantics

- **Receipt chain** — senders observe `receiver_received` → `injected (opencode session …)` for every message.
- **Staleness guard** — auto-reply ships only text produced after the ask was injected.
- **Ask race safety** — a reply arriving before the ask handler registers is buffered (bounded, 30 s TTL) and still resolves the ask.
- **Presence** — `idle` / `thinking` / `tool:<name>` from session status and tool execution events; the model label tracks the live session model.
- **Pending-ask hygiene** — inbound asks expire after `askTimeoutMs`; they never leak.
- **Scope isolation** — peers see each other only when `PI_INTERCOM_SCOPE_ID` matches; leave unset for the shared default scope.

## Configuration

`~/.config/opencode/intercom.json` (all optional):

```jsonc
{
  "enabled": true,
  "name": "opencode",            // roster name; MUST be unique per instance
  "agentDir": null,              // default PI_CODING_AGENT_DIR or ~/.omp/agent
                                  // "~/.pi/agent" joins a pi-intercom roster instead
  "sessionID": null,             // fixed target session; default: active/latest
  "bridgeModel": null,           // "providerID/modelID" forced on injected prompts
  "autoReply": true,             // auto-send the newest assistant text as the ask reply
  "inboundTrigger": "always",    // always | replies | never
  "askTimeoutMs": 600000,
  "stableId": null               // restart-stable intercom session id
}
```

Env overrides: `OPENCODE_INTERCOM_ENABLED`, `OPENCODE_INTERCOM_NAME`,
`OPENCODE_INTERCOM_AGENT_DIR`, `OPENCODE_INTERCOM_SESSION_ID`,
`OPENCODE_INTERCOM_MODEL`, `OPENCODE_INTERCOM_AUTO_REPLY`,
`OPENCODE_INTERCOM_CONFIG`. Shared vars honored: `PI_CODING_AGENT_DIR`,
`PI_INTERCOM_SCOPE_ID`, `PI_INTERCOM_ASK_TIMEOUT_MS`, `PI_INTERCOM_LIVENESS_*`.

## Testing

```bash
bun test   # 52 tests, green
```

| Suite | Covers |
| --- | --- |
| Unit | framing (split/oversize/malformed frames), protocol guard, paths, config precedence |
| Session bridge | target-session resolution, injection bodies, assistant-text extraction, event mapping |
| V2 adapter | `ctx.session.prompt`/`synthetic`/`switchModel` mapping, `{ data }` envelopes, model label via `ctx.model.default()`, tool registration + input narrowing, event subscription cleanup |
| Client ↔ fake broker | register, send/ack, ask resolve/timeout + `cancel_ask`, receipts, presence, liveness + half-open detection |
| Real-broker integration | roster, ask round-trip, receipt chain, fail-closed sends, mailbox redelivery |
| Hub full loop | inbound ask → injection → simulated run → auto-reply; staleness guard; `noReply`; tool actions; no re-inject of own ask replies |

Integration suites auto-skip without the real broker source; point
`INTERCOM_TEST_BROKER` at a `broker.ts` to force them.

## Troubleshooting

- **`intercom tool disabled` in logs (V1 only)** — `@opencode-ai/plugin` did not resolve; for local installs add `~/.config/opencode/package.json` with `{ "dependencies": { "@opencode-ai/plugin": "^1.18.31" } }`. The V2 path registers the tool without that package.
- **Asks stall** — the target session is busy with a long agent run; injected prompts queue behind it. Wait, `POST /session/:id/abort`, or set `sessionID` to a dedicated session.
- **Ambiguous sends** — two instances registered with the same `name` fail closed. Give each instance a unique `name` (or `OPENCODE_INTERCOM_NAME`); use unique `PEER_NAME`s for test peers.
- **No plugin load in serve mode** — Open Design's embedded opencode dev builds skip config plugins in serve mode and are rejected by the Zen free tier; use the official CLI.
- **Muse Spark** — requires OpenCode-side Zen access (`opencode auth login`); free-tier models work from official clients ≥ 1.18.

## Development

```bash
bun install
bun test        # full suite
bun build src/index.ts --target=bun --outfile /dev/null   # syntax gate
```

Local install for iterating (V2): drop a re-exporting file into a discovered
plugins directory —

```bash
echo 'export { default } from "/path/to/opencode-pi-intercom/src/index.ts";' \
  > ~/.config/opencode/plugins/pi-intercom.ts
```

For V1, point the config `"plugin"` entry at
`./plugins/opencode-pi-intercom.ts` re-exporting `IntercomPlugin` instead.

Release flow: change → `bun test` → version bump → commit → `git push` →
`npm publish`.

## License

MIT © Betül Tarhan
