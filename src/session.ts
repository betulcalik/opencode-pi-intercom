// OpenCode SDK bridge: session tracking, prompt injection, assistant text
// retrieval, model label discovery. The generated SDK drifts between OpenCode
// builds, so every read is narrowed with runtime checks at this boundary —
// no `any`, no unchecked casts.

import type { IntercomPluginConfig } from "./config.ts";

export interface SdkClient {
  session?: {
    list?: () => Promise<unknown>;
    create?: (args: unknown) => Promise<unknown>;
    prompt?: (args: unknown) => Promise<unknown>;
    messages?: (args: unknown) => Promise<unknown>;
  };
  config?: {
    providers?: () => Promise<unknown>;
  };
  app?: {
    log?: (args: unknown) => Promise<unknown>;
  };
}

function unwrap(response: unknown): unknown {
  if (typeof response === "object" && response !== null && "data" in response) {
    return response.data;
  }
  return response;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function pickSessionID(properties: unknown): string | null {
  const record = asRecord(properties);
  if (!record) return null;
  if (typeof record.sessionID === "string") return record.sessionID;
  const info = asRecord(record.info);
  if (info && typeof info.sessionID === "string") return info.sessionID;
  const session = asRecord(record.session);
  if (session && typeof session.id === "string") return session.id;
  return null;
}

function entryId(entry: unknown): string | null {
  const record = asRecord(entry);
  return record && typeof record.id === "string" ? record.id : null;
}

function entryTimeUpdated(entry: unknown): number {
  const record = asRecord(entry);
  const time = asRecord(record?.time);
  return time && typeof time.updated === "number" ? time.updated : 0;
}

export class SessionBridge {
  currentSessionId: string | null = null;
  modelLabel = "opencode";
  onIdle: ((sessionID: string) => void) | null = null;
  onRunning: ((running: boolean) => void) | null = null;

  constructor(
    private client: SdkClient,
    private cfg: IntercomPluginConfig,
    private log: (...args: unknown[]) => void,
  ) {}

  trackEvent(type: string, properties: unknown): void {
    const sessionID = pickSessionID(properties);
    if (sessionID && (type.startsWith("session.") || type.startsWith("message."))) {
      this.currentSessionId = sessionID;
    }
    if (type === "session.idle" && sessionID) this.onIdle?.(sessionID);
    if (type === "session.status") {
      const status = asRecord(properties)?.status;
      this.onRunning?.(status === "running" || status === "busy" || status === "retry");
    }
    if (type === "message.updated") {
      const info = asRecord(asRecord(properties)?.info);
      if (info && typeof info.providerID === "string" && typeof info.modelID === "string") {
        this.modelLabel = `${info.providerID}/${info.modelID}`;
      }
    }
  }

  async resolveTargetSession(senderLabel?: string): Promise<string> {
    if (this.cfg.sessionID) return this.cfg.sessionID;
    if (this.currentSessionId) return this.currentSessionId;
    const sessions = unwrap(await this.client.session?.list?.());
    if (Array.isArray(sessions) && sessions.length > 0) {
      const latest = [...sessions].sort((a, b) => entryTimeUpdated(b) - entryTimeUpdated(a))[0];
      const id = entryId(latest);
      if (id) {
        this.currentSessionId = id;
        return id;
      }
    }
    const created = unwrap(await this.client.session?.create?.({ body: { title: senderLabel ? `intercom ← ${senderLabel}` : "intercom" } }));
    const createdId = entryId(created);
    if (!createdId) {
      throw new Error("could not resolve or create an OpenCode session for intercom injection");
    }
    this.currentSessionId = createdId;
    const via = senderLabel ? ` for inbound from ${senderLabel}` : "";
    this.log(`no live session found — created fallback session ${createdId}${via}; pin a target with "sessionID" in ~/.config/opencode/intercom.json`);
    return createdId;
  }

  /**
   * Inject a prompt into a resolved session and start the agent run.
   * Fire-and-forget: the HTTP call resolves when the whole run finishes, which
   * we deliberately do not await.
   */
  async injectInto(sessionID: string, text: string, opts: { noReply: boolean }): Promise<void> {
    const body: Record<string, unknown> = {
      parts: [{ type: "text", text }],
      ...(opts.noReply ? { noReply: true } : {}),
      ...(this.cfg.bridgeModel ? { model: this.cfg.bridgeModel } : {}),
    };
    void this.client.session?.prompt?.({ path: { id: sessionID }, body })?.catch((error: unknown) => {
      this.log(`prompt injection failed: ${String(error)}`);
    });
  }

  async lastAssistantText(sessionID: string): Promise<string | null> {
    const entries = unwrap(await this.client.session?.messages?.({ path: { id: sessionID } }));
    if (!Array.isArray(entries)) return null;
    for (const entry of [...entries].reverse()) {
      const record = asRecord(entry);
      const info = asRecord(record?.info);
      if (info?.role !== "assistant") continue;
      if (!Array.isArray(record?.parts)) continue;
      const texts: string[] = [];
      for (const part of record.parts) {
        const partRecord = asRecord(part);
        if (partRecord?.type === "text" && typeof partRecord.text === "string") {
          texts.push(partRecord.text);
        }
      }
      if (texts.length > 0) return texts.join("\n");
    }
    return null;
  }

  async refreshModelLabel(): Promise<string> {
    const result = asRecord(unwrap(await this.client.config?.providers?.()));
    const defaults = asRecord(result?.default);
    const label =
      defaults && typeof defaults.build === "string"
        ? defaults.build
        : defaults && typeof defaults.plan === "string"
          ? defaults.plan
          : null;
    if (label) this.modelLabel = label;
    return this.modelLabel;
  }
}
