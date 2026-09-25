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
        const selected = asRecord(await ctx.model?.default?.());
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
