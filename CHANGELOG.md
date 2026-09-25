# Changelog

## 0.3.0 — 2026-09-25

- **OpenCode V2 support** from the same package: the entrypoint now
  default-exports both a V2 definition (`id: "opencode.pi-intercom"` +
  `setup()`) and the V1 `server()` function, so V2 (`plugins` key) and
  V1 ≥ 1.18.29 (`plugin` key) each load their own path. Older V1 releases keep
  working through the named `IntercomPlugin` export. Verified end-to-end on
  OpenCode v2.0.16 (broker registration, `intercom` tool, injected ask →
  agent run → auto-reply round-trip).
- **V2 adapter** (`src/v2.ts`): maps the V2 plugin context onto the existing
  harness-agnostic `SdkClient` boundary — `ctx.session.prompt` for injections,
  `ctx.session.synthetic` for `noReply` context-only messages,
  `ctx.session.switchModel` for `bridgeModel`, `ctx.session.context` for
  assistant-text retrieval, `ctx.model.default()` for the model label, and
  `ctx.event.subscribe()` for session tracking. The broker core
  (`startIntercom`, `SessionBridge`, client, protocol) is unchanged.
- **V2 tool registration** via `ctx.tool.transform` with plain JSON Schema;
  untyped tool input is narrowed at runtime and invalid actions return an
  error string instead of throwing. The `@opencode-ai/plugin` dynamic import
  is now V1-only.
- **V2 event normalization** (`normalizeV2Event`): the V2 stream uses a
  `data` envelope and different lifecycle names than V1, so events are mapped
  before reaching the session bridge — `session.execution.started` → busy
  presence, `session.execution.succeeded`/`failed`/`cancelled` → idle +
  auto-reply trigger, `session.step.started` → live model label. Shapes
  verified against a live v2.0.16 event stream.
- **Model label fix**: `ctx.model.default()` returns a `{ location, data }`
  envelope; the adapter unwraps `data` before reading `providerID`/`modelID`.
- **Reload-safe lifecycle**: the process-wide init guard resets when the
  plugin unloads, when setup fails, or when the plugin is disabled, so OpenCode
  config-triggered reloads can reinitialize the broker connection; tool/hook
  registrations are disposed on cleanup.
- **Cleanup**: `setup()` returns a dispose function that aborts the event
  subscription and releases the broker connection on plugin unload.
- 58 tests (45 existing + 13 new V2 adapter/normalization/setup tests).

## 0.2.0 — 2026-09-18

- **Harness & capabilities metadata**: registration advertises `harness: "opencode"` and delivery `capabilities` (`steer: false, ask: true, …`); `list` rows render an `[oc]` badge and a `queues (no steer)` note. Additive protocol fields — older peers ignore them. (#2)
- **Fallback session surfacing**: when no live session exists, the auto-created session is now titled `intercom ← <sender>` and an explicit warning is logged instead of silently splitting context. (#2)
- **Log routing**: plugin logs go to the OpenCode server log (`client.app.log`) instead of stderr, so routine output no longer renders as red error text in the TUI; falls back to stderr when the SDK shape drifts. (#1)

## 0.1.0 — 2026-09-18

Initial release.

- omp/pi-intercom broker peer: registration, presence (`idle`/`thinking`/`tool:<name>`), live model label
- Inbound prompt injection with `receiver_received` → `injected` receipt chain and `inboundTrigger` policy
- Agent-facing `intercom` tool: `list` / `list-cwd` / `send` / `ask` / `reply` / `status`
- Ask/reply threading with bounded timeouts, `cancel_ask`, mailbox redelivery
- Auto-reply with pre-injection staleness guard; ask-race reply buffering
- Broker auto-spawn from the installed omp-intercom package; liveness heartbeat + reconnect
- 45-test suite incl. real-broker integration and full hub round-trip
