// OpenCode V2 adapter: maps the V2 plugin context (@opencode/plugin) onto the
// harness-agnostic `SdkClient` boundary from session.ts, so SessionBridge and
// the whole broker core stay identical between V1 and V2.
//
// Same discipline as session.ts: the context is treated as untyped and every
// access is feature-detected / narrowed at runtime — the V2 API is young and
// may drift between releases.
//
// V1 → V2 mapping used here:
//   client.session.list/create/prompt/messages → ctx.session.list/create/prompt/context
//   prompt body { noReply: true }              → ctx.session.synthetic (context-only message)
//   prompt body { model }                      → ctx.session.switchModel before prompting
//   client.config.providers() default label    → ctx.model.default()
//   returned `event` hook                      → ctx.event.subscribe() async iterable
//   returned tool map + tool() helper          → ctx.tool.transform() with JSON Schema
//   tool.execute.before/after hooks            → ctx.tool.hook("execute.before"/"execute.after")

import type { IntercomPluginConfig } from "./config.ts";
import type { SdkClient } from "./session.ts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Structural view of the V2 plugin context — only what this plugin touches. */
export interface V2PluginContext {
  location?: { directory?: string };
  session?: {
    list?: (input?: unknown) => Promise<unknown>;
    create?: (input: { title?: string }) => Promise<unknown>;
    prompt?: (input: { sessionID: string; text: string }) => Promise<unknown>;
    synthetic?: (input: { sessionID: string; text: string }) => Promise<unknown>;
    context?: (input: { sessionID: string }) => Promise<unknown>;
    switchModel?: (input: {
      sessionID: string;
      model: { providerID: string; id: string };
    }) => Promise<unknown>;
  };
  model?: {
    default?: () => Promise<unknown>;
  };
  tool?: {
    transform?: (callback: (editor: { add(tool: unknown): void }) => void) => Promise<unknown>;
    hook?: (
      name: "execute.before" | "execute.after",
      callback: (event: { tool?: string }) => Promise<void> | void,
    ) => Promise<unknown>;
  };
  event?: {
    subscribe?: (options?: {
      signal?: AbortSignal;
    }) => AsyncIterable<{ type: string; properties?: unknown }>;
  };
}

function pickSessionIDArg(args: unknown): string | null {
  const path = asRecord(asRecord(args)?.path);
  return typeof path?.id === "string" ? path.id : null;
}

function pickPromptText(args: unknown): string {
  const body = asRecord(asRecord(args)?.body);
  const parts = Array.isArray(body?.parts) ? body.parts : [];
  const texts: string[] = [];
  for (const part of parts) {
    const record = asRecord(part);
    if (record?.type === "text" && typeof record.text === "string") texts.push(record.text);
  }
  return texts.join("\n");
}

/**
 * Build an SdkClient over the V2 context. Missing methods are simply omitted —
 * SessionBridge already degrades gracefully (e.g. no `list` → creates a
 * fallback session; no `messages` → auto-reply stays silent).
 *
 * Verified against OpenCode v2.0.16: the plugin context exposes no
 * `session.list`, and `ctx.model.default()` returns a `{ location, data }`
 * envelope whose `data` carries the Model.Info.
 */
export function makeV2Sdk(
  ctx: V2PluginContext,
  cfg: IntercomPluginConfig,
  log: (...args: unknown[]) => void,
): SdkClient {
  const session = ctx.session;
  return {
    session: {
      list: session?.list
        ? async () => {
            try {
              return { data: await session.list?.(undefined) };
            } catch (error) {
              // Older/newer V2 builds may not expose list on the plugin context;
              // an empty result makes the bridge fall back to creating a session.
              log(`session.list failed (${String(error)}) — will fall back to session tracking`);
              return { data: [] };
            }
          }
        : undefined,
      create: session?.create
        ? async (args: unknown) => {
            const body = asRecord(asRecord(args)?.body);
            const title = typeof body?.title === "string" ? body.title : undefined;
            return { data: await session.create?.({ title }) };
          }
        : undefined,
      prompt:
        session?.prompt || session?.synthetic
          ? async (args: unknown) => {
              const sessionID = pickSessionIDArg(args);
              if (!sessionID) throw new Error("v2 adapter: prompt call without a session id");
              const text = pickPromptText(args);
              const noReply = asRecord(asRecord(args)?.body)?.noReply === true;
              if (noReply) {
                if (!session.synthetic) {
                  log("ctx.session.synthetic unavailable — noReply message dropped (not injected)");
                  return { data: null };
                }
                return { data: await session.synthetic({ sessionID, text }) };
              }
              // bridgeModel pins the SESSION model in V2 (there is no per-request
              // model override on ctx.session.prompt) — it persists for later
              // user prompts too, unlike the V1 per-request body field.
              if (cfg.bridgeModel && session.switchModel) {
                await session.switchModel({
                  sessionID,
                  model: { providerID: cfg.bridgeModel.providerID, id: cfg.bridgeModel.modelID },
                });
              }
              if (!session.prompt) throw new Error("v2 adapter: ctx.session.prompt unavailable");
              return { data: await session.prompt({ sessionID, text }) };
            }
          : undefined,
      messages: session?.context
        ? async (args: unknown) => {
            const sessionID = pickSessionIDArg(args);
            if (!sessionID) return { data: [] };
            return { data: await session.context?.({ sessionID }) };
          }
        : undefined,
    },
    config: {
      providers: async () => {
        const result = asRecord(await ctx.model?.default?.());
        const selected = asRecord(result?.data) ?? result;
        const providerID = typeof selected?.providerID === "string" ? selected.providerID : null;
        const modelID = typeof selected?.modelID === "string" ? selected.modelID : null;
        return { data: { default: providerID && modelID ? { build: `${providerID}/${modelID}` } : {} } };
      },
    },
    // No ctx.app.log in V2 — the wrapper's logger goes to console, so the
    // SessionBridge never touches this branch.
    app: {},
  };
}

/**
 * Normalize a V2 event-stream entry into one or more legacy-shaped events that
 * SessionBridge.trackEvent understands. Verified against OpenCode v2.0.16:
 *
 * - V2 events carry their payload under `data` (not V1's `properties`).
 * - V1's `session.idle` does not exist; execution ends with
 *   `session.execution.succeeded` / `.failed` / `.cancelled`.
 * - V1's `session.status` does not exist; `session.execution.started` marks a
 *   run start, the end events above mark its finish.
 * - V1's `message.updated` (with `info.providerID/modelID`) does not exist;
 *   the live model rides on `session.step.started` (`data.model`).
 *
 * One V2 event can expand into several legacy events (e.g. a finished run is
 * both "status idle" and "session.idle" for the auto-reply path).
 */
export function normalizeV2Event(event: {
  type?: unknown;
  data?: unknown;
  properties?: unknown;
}): Array<{ type: string; properties: unknown }> {
  const type = typeof event.type === "string" ? event.type : "";
  if (!type) return [];
  const data = asRecord(event.data) ?? asRecord(event.properties);
  const sessionID = typeof data?.sessionID === "string" ? data.sessionID : null;

  switch (type) {
    case "session.execution.started":
      return sessionID
        ? [{ type: "session.status", properties: { sessionID, status: "busy" } }]
        : [];
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.cancelled":
      return sessionID
        ? [
            { type: "session.status", properties: { sessionID, status: "idle" } },
            { type: "session.idle", properties: { sessionID } },
          ]
        : [];
    case "session.step.started": {
      const model = asRecord(data?.model);
      const providerID = typeof model?.providerID === "string" ? model.providerID : null;
      const modelID = typeof model?.id === "string" ? model.id : null;
      if (!sessionID || !providerID || !modelID) return [{ type, properties: data }];
      // message.* prefix also feeds the bridge's current-session tracking.
      return [
        { type: "message.updated", properties: { sessionID, info: { providerID, modelID } } },
      ];
    }
    default:
      return [{ type, properties: data }];
  }
}
