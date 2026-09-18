// opencode-pi-intercom — OpenCode plugin that joins the omp-intercom / pi-intercom
// broker roster as a peer: receives injected prompts, exposes the `intercom`
// tool to the agent, publishes presence, and auto-spawns the shared broker.
//
// `startIntercom` is the testable core (config + fake-able SDK + cwd);
// `IntercomPlugin` is the thin OpenCode plugin wrapper around it.

import { loadConfig } from "./config.ts";
import type { IntercomPluginConfig } from "./config.ts";
import { getBrokerSocketPath } from "./paths.ts";
import { ensureBroker } from "./broker-spawn.ts";
import { IntercomClient } from "./client.ts";
import { SessionBridge } from "./session.ts";
import type { SdkClient } from "./session.ts";
import { formatInboundPrompt } from "./format.ts";
import { makeIntercomTool } from "./tool.ts";
import type { IntercomToolArgs } from "./tool.ts";
import type { Message, SessionInfo, SessionRegistration } from "./protocol.ts";

interface PendingInboundAsk {
  from: SessionInfo;
  sessionID: string;
  at: number;
  /** Last assistant text before this ask was injected — auto-reply must produce something NEWER. */
  preInject: string | null;
}

export interface IntercomHooks {
  event: (payload: { event: { type: string; properties: unknown } }) => Promise<void>;
  "tool.execute.before": (input: { tool?: string }) => Promise<void>;
  "tool.execute.after": () => Promise<void>;
}

export interface StartedIntercom {
  hooks: IntercomHooks;
  hub: { handleTool(args: IntercomToolArgs): Promise<string> };
  stop: () => void;
}

export interface IntercomDeps {
  cfg: IntercomPluginConfig;
  sdk: SdkClient;
  cwd: string;
  log: (...args: unknown[]) => void;
}

export function startIntercom(deps: IntercomDeps): StartedIntercom {
  const { cfg, sdk, cwd, log } = deps;
  const bridge = new SessionBridge(sdk, cfg, log);
  const client = new IntercomClient();

  const startedAt = Date.now();
  let lastActivity = Date.now();
  let statusLabel = "idle";
  let reconnectTimer: NodeJS.Timeout | null = null;
  let reconnectAttempt = 0;
  let stopped = false;
  const pendingInboundAsks = new Map<string, PendingInboundAsk>();
  /** Message ids of our in-flight outbound asks — their replies are tool results, not prompts. */
  const outboundAsks = new Set<string>();
  const warnedDuplicateNames = new Set<string>();

  const registration = (): SessionRegistration => ({
    cwd,
    model: bridge.modelLabel,
    pid: process.pid,
    startedAt,
    lastActivity,
    name: cfg.name,
    status: statusLabel,
    harness: "opencode",
    capabilities: { steer: false, ask: true, ui: false, attachments: false },
  });

  const setPresenceStatus = (label: string) => {
    statusLabel = label;
    lastActivity = Date.now();
    client.presence({ status: label, model: bridge.modelLabel });
  };

  const warnDuplicateName = (session: SessionInfo) => {
    if (session.name !== cfg.name || session.id === client.id) return;
    if (warnedDuplicateNames.has(session.id)) return;
    warnedDuplicateNames.add(session.id);
    log(
      `WARNING: another session registered as "${cfg.name}" — sends to this name will be ambiguous. ` +
        `Give each instance a unique "name" in ~/.config/opencode/intercom.json.`,
    );
  };

  /** Drop inbound asks whose asker has long since timed out. */
  const sweepExpiredAsks = () => {
    const now = Date.now();
    for (const [id, pending] of [...pendingInboundAsks]) {
      if (now - pending.at > cfg.askTimeoutMs) {
        pendingInboundAsks.delete(id);
        log(`dropped expired inbound ask ${id}`);
      }
    }
  };

  const onInbound = async (from: SessionInfo, message: Message) => {
    // A reply to one of OUR outbound asks resolves the pending tool call —
    // injecting it as a fresh prompt would duplicate it into the session.
    if (message.replyTo && outboundAsks.has(message.replyTo)) {
      lastActivity = Date.now();
      return;
    }
    lastActivity = Date.now();
    sweepExpiredAsks();
    client.sendReceipt(message.id, "receiver_received");
    const wantsReply = message.expectsReply === true;
    const trigger = cfg.inboundTrigger === "always" || (cfg.inboundTrigger === "replies" && wantsReply);
    const text = formatInboundPrompt(from, message);
    try {
      const sessionID = await bridge.resolveTargetSession(from.name ?? from.id.slice(0, 8));
      // Snapshot before injection so auto-reply only ever sends text produced
      // AFTER this ask, never a stale assistant message.
      const preInject = wantsReply ? await bridge.lastAssistantText(sessionID).catch(() => null) : null;
      // Register the pending ask BEFORE the prompt fires: an OpenCode plugin
      // hook (or a very fast agent) can emit session.idle synchronously with
      // the injection, and auto-reply must already know about the ask then.
      if (wantsReply) {
        pendingInboundAsks.set(message.id, { from, sessionID, at: Date.now(), preInject });
      }
      try {
        await bridge.injectInto(sessionID, text, { noReply: !trigger });
      } catch (error) {
        pendingInboundAsks.delete(message.id);
        throw error;
      }
      client.sendReceipt(message.id, "injected", `opencode session ${sessionID}`);
      log(`injected message ${message.id} from ${from.name ?? from.id} into session ${sessionID}`);
    } catch (error) {
      log(`failed to inject message ${message.id}: ${String(error)}`);
    }
  };

  client.on("message", (from: SessionInfo, message: Message) => {
    void onInbound(from, message);
  });
  client.on("peer-joined", warnDuplicateName);
  client.on("presence", warnDuplicateName);
  client.on("disconnected", () => {
    if (!stopped) {
      log("broker disconnected; reconnecting");
      void connectLoop();
    }
  });

  bridge.onIdle = (sessionID) => {
    setPresenceStatus("idle");
    sweepExpiredAsks();
    if (!cfg.autoReply) return;
    for (const [messageId, pending] of [...pendingInboundAsks]) {
      if (pending.sessionID !== sessionID) continue;
      void bridge.lastAssistantText(sessionID).then((text) => {
        if (!text || text === pending.preInject) return;
        pendingInboundAsks.delete(messageId);
        const to = pending.from.name ?? pending.from.id;
        void client.reply(to, messageId, text).then((result) => {
          log(`auto-reply to ${to}: delivered=${result.delivered}`);
        });
      });
    }
  };
  bridge.onRunning = (running) => {
    if (running && statusLabel !== "tool") setPresenceStatus("thinking");
  };

  const connectLoop = async (): Promise<void> => {
    while (!stopped) {
      try {
        await ensureBroker(cfg.agentDir, log);
        await client.connect(getBrokerSocketPath(cfg.agentDir), registration(), cfg.stableId);
        reconnectAttempt = 0;
        warnedDuplicateNames.clear();
        log(`connected to broker as "${cfg.name}" (session ${client.id})`);
        return;
      } catch (error) {
        reconnectAttempt += 1;
        const delay = Math.min(1000 * 2 ** Math.min(reconnectAttempt, 4), 15_000);
        log(`broker connect failed (${String(error)}); retrying in ${delay / 1000}s`);
        const { promise, resolve } = Promise.withResolvers<void>();
        reconnectTimer = setTimeout(resolve, delay);
        reconnectTimer.unref?.();
        await promise;
      }
    }
  };

  const resolveTarget = async (to?: string, targetCwd?: string): Promise<string | null> => {
    if (to) return to;
    if (!targetCwd) return null;
    const matches = (await client.list()).filter((s) => s.id !== client.id && s.cwd === targetCwd);
    if (matches.length === 1) return matches[0].name ?? matches[0].id;
    return null;
  };

  const hub = {
    async handleTool(args: IntercomToolArgs): Promise<string> {
      if (!client.isConnected()) {
        return "Error: intercom client is not connected (broker unreachable; retrying in background).";
      }
      switch (args.action) {
        case "status":
          return [
            `connected: ${client.isConnected()}`,
            `name: ${cfg.name}`,
            `sessionId: ${client.id ?? "-"}`,
            `cwd: ${cwd}`,
            `model: ${bridge.modelLabel}`,
            `status: ${statusLabel}`,
            `pending inbound asks: ${pendingInboundAsks.size}`,
          ].join("\n");
        case "list":
        case "list-cwd": {
          const sessions = await client.list();
          const others = sessions.filter(
            (s) => s.id !== client.id && (args.action === "list" || s.cwd === cwd),
          );
          if (others.length === 0) return "No other intercom sessions connected.";
          return others
            .map(
              (s) => {
                const badge = s.harness ? `[${s.harness === "opencode" ? "oc" : s.harness}] ` : "";
                const steerNote = s.capabilities?.steer === false ? " · queues (no steer)" : "";
                return `• ${badge}${s.name ?? s.id.slice(0, 8)} (${s.id.slice(0, 8)}) — ${s.cwd} (${s.model}${s.status ? ` · ${s.status}` : ""}${steerNote})`;
              },
            )
            .join("\n");
        }
        case "send": {
          if (!args.message) return "Error: 'message' is required for send.";
          const target = await resolveTarget(args.to, args.cwd);
          if (!target) return "Error: provide 'to' (or a 'cwd' with exactly one live session).";
          const result = await client.send(target, args.message);
          if (!result.delivered) return `Failed: ${result.reason}`;
          return `Message sent to ${target}${result.delivery === "queued" ? " (queued — target gets it on reconnect)" : ""}.`;
        }
        case "ask": {
          if (!args.message) return "Error: 'message' is required for ask.";
          const target = await resolveTarget(args.to, args.cwd);
          if (!target) return "Error: provide 'to' (or a 'cwd' with exactly one live session).";
          let askMessageId: string | null = null;
          try {
            const result = await client.ask(target, args.message, cfg.askTimeoutMs, (id) => {
              askMessageId = id;
              outboundAsks.add(id);
            });
            return `Reply from ${result.fromName}:\n\n${result.replyText}`;
          } finally {
            if (askMessageId) outboundAsks.delete(askMessageId);
          }
        }
        case "reply": {
          if (!args.message) return "Error: 'message' is required for reply.";
          let replyTo = args.replyTo ?? null;
          let to: string | null = null;
          if (!replyTo && pendingInboundAsks.size === 1) {
            const [soleId, sole] = [...pendingInboundAsks][0];
            replyTo = soleId;
            to = sole.from.name ?? sole.from.id;
          }
          if (!replyTo) {
            return "Error: no 'replyTo' given and not exactly one pending inbound ask to infer from.";
          }
          if (!to) {
            const pending = pendingInboundAsks.get(replyTo);
            to = pending ? pending.from.name ?? pending.from.id : args.to ?? "";
          }
          if (!to) return "Error: cannot determine reply target; pass 'to'.";
          const result = await client.reply(to, replyTo, args.message);
          if (!result.delivered) return `Failed to send reply: ${result.reason}`;
          pendingInboundAsks.delete(replyTo);
          return `Reply sent to ${to}.`;
        }
        default:
          return `Unknown action: ${String(args.action)}`;
      }
    },
  };

  const stop = () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    try {
      client.unregister();
    } catch {
      // already gone
    }
  };

  // Connection must never block the host's startup path.
  void bridge.refreshModelLabel().catch(() => {});
  void connectLoop();

  return {
    hub,
    stop,
    hooks: {
      event: async ({ event }: { event: { type: string; properties: unknown } }) => {
        try {
          bridge.trackEvent(event.type, event.properties);
        } catch (error) {
          log(`event handling failed: ${String(error)}`);
        }
      },
      "tool.execute.before": async (input: { tool?: string }) => {
        if (input?.tool) {
          statusLabel = "tool";
          client.presence({ status: `tool:${input.tool}`, model: bridge.modelLabel });
        }
      },
      "tool.execute.after": async () => {
        setPresenceStatus("thinking");
      },
    },
  };
}

interface PluginContext {
  client?: unknown;
  directory?: string;
  worktree?: string;
}

// Module-level singleton: some entry paths evaluate the loader more than once
// per process; only the first factory run may own the broker connection.
let initializedInProcess = false;

export const IntercomPlugin = async (ctx: PluginContext) => {
  if (initializedInProcess) {
    return {};
  }
  initializedInProcess = true;

  const cfg = loadConfig();

  // Plugin ctx is untyped; SessionBridge narrows every SDK access at runtime.
  const sdk = (typeof ctx.client === "object" && ctx.client !== null ? ctx.client : {}) as SdkClient;
  const log = (...args: unknown[]) => {
    const message = args.map(String).join(" ");
    // Route through the OpenCode server log so plugin output never spams the TUI
    // (console.error renders as red text over the input area). Fall back to
    // stderr if the SDK shape drifts.
    const entry = sdk.app?.log?.({ body: { service: "opencode-pi-intercom", level: "info", message } });
    if (entry) {
      entry.catch(() => console.error("[opencode-pi-intercom]", message));
    } else {
      console.error("[opencode-pi-intercom]", message);
    }
  };
  if (!cfg.enabled) {
    log("disabled by config");
    return {};
  }

  const started = startIntercom({ cfg, sdk, cwd: ctx.directory ?? process.cwd(), log });

  const shutdown = () => started.stop();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("beforeExit", shutdown);

  const intercomTool = await makeIntercomTool(started.hub, log);
  return {
    ...(intercomTool ? { tool: { intercom: intercomTool } } : {}),
    event: started.hooks.event,
    "tool.execute.before": started.hooks["tool.execute.before"],
    "tool.execute.after": started.hooks["tool.execute.after"],
  };
};
