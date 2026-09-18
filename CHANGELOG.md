# Changelog

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
