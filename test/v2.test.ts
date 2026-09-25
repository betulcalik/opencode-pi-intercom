// V2 adapter tests: the V2 plugin context is faked structurally and the
// SdkClient shim (makeV2Sdk) + setup wiring (setupV2Intercom) are verified
// against it. No broker and no opencode process required — the broker core
// itself is covered by hub.test.ts against the real broker.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { makeV2Sdk, normalizeV2Event } from "../src/v2.ts";
import type { V2PluginContext } from "../src/v2.ts";
import { setupV2Intercom } from "../src/index.ts";
import type { IntercomPluginConfig } from "../src/config.ts";

interface V2Calls {
  prompts: Array<{ sessionID: string; text: string }>;
  synthetics: Array<{ sessionID: string; text: string }>;
  switchModels: Array<{ sessionID: string; model: { providerID: string; id: string } }>;
  creates: Array<{ title?: string }>;
  tools: Array<{
    name: string;
    description: string;
    input: Record<string, unknown>;
    execute: (input: unknown) => Promise<{ content: string }>;
  }>;
  hooks: Array<{ name: string; callback: (event: { tool?: string }) => unknown }>;
}

function makeCfg(agentDir: string, overrides: Partial<IntercomPluginConfig> = {}): IntercomPluginConfig {
  return {
    enabled: true,
    name: "oc-v2",
    agentDir,
    sessionID: null,
    bridgeModel: null,
    autoReply: true,
    inboundTrigger: "always",
    askTimeoutMs: 8_000,
    stableId: null,
    ...overrides,
  };
}

function makeFakeCtx(events?: AsyncIterable<{ type: string; properties?: unknown }>): {
  ctx: V2PluginContext;
  calls: V2Calls;
} {
  const calls: V2Calls = { prompts: [], synthetics: [], switchModels: [], creates: [], tools: [], hooks: [] };
  const ctx: V2PluginContext = {
    location: { directory: "/tmp/v2-cwd" },
    session: {
      list: async () => [{ id: "ses_v2", time: { updated: 7 } }],
      create: async (input) => {
        calls.creates.push(input);
        return { id: "ses_created" };
      },
      prompt: async (input) => {
        calls.prompts.push(input);
        return { id: "msg_1" };
      },
      synthetic: async (input) => {
        calls.synthetics.push(input);
        return { id: "msg_synth" };
      },
      context: async () => [
        { info: { role: "user" }, parts: [{ type: "text", text: "hi" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "ANSWER" }] },
      ],
      switchModel: async (input) => {
        calls.switchModels.push(input);
      },
    },
    model: { default: async () => ({ data: { providerID: "opencode", modelID: "muse-spark-1.3" } }) },
    tool: {
      transform: async (callback) => {
        callback({ add: (tool) => calls.tools.push(tool as V2Calls["tools"][number]) });
        return { dispose: async () => {} };
      },
      hook: async (name, callback) => {
        calls.hooks.push({ name, callback });
        return { dispose: async () => {} };
      },
    },
    event: events ? { subscribe: () => events } : undefined,
  };
  return { ctx, calls };
}

function tmpAgentDir(): string {
  return mkdtempSync(join(tmpdir(), "intercom-v2-test-"));
}

describe("makeV2Sdk", () => {
  const agentDir = tmpAgentDir();

  test("prompt maps V1-style { path, body.parts } onto ctx.session.prompt({ sessionID, text })", async () => {
    const { ctx, calls } = makeFakeCtx();
    const sdk = makeV2Sdk(ctx, makeCfg(agentDir), () => {});
    await sdk.session?.prompt?.({
      path: { id: "ses_v2" },
      body: { parts: [{ type: "text", text: "hello from intercom" }] },
    });
    expect(calls.prompts).toEqual([{ sessionID: "ses_v2", text: "hello from intercom" }]);
    expect(calls.synthetics).toHaveLength(0);
  });

  test("noReply injection becomes a synthetic (context-only) message", async () => {
    const { ctx, calls } = makeFakeCtx();
    const sdk = makeV2Sdk(ctx, makeCfg(agentDir), () => {});
    await sdk.session?.prompt?.({
      path: { id: "ses_v2" },
      body: { parts: [{ type: "text", text: "context only" }], noReply: true },
    });
    expect(calls.synthetics).toEqual([{ sessionID: "ses_v2", text: "context only" }]);
    expect(calls.prompts).toHaveLength(0);
  });

  test("bridgeModel switches the session model before prompting", async () => {
    const { ctx, calls } = makeFakeCtx();
    const sdk = makeV2Sdk(
      ctx,
      makeCfg(agentDir, { bridgeModel: { providerID: "opencode", modelID: "muse-spark-1.3" } }),
      () => {},
    );
    await sdk.session?.prompt?.({ path: { id: "ses_v2" }, body: { parts: [{ type: "text", text: "go" }] } });
    expect(calls.switchModels).toEqual([
      { sessionID: "ses_v2", model: { providerID: "opencode", id: "muse-spark-1.3" } },
    ]);
    expect(calls.prompts).toHaveLength(1);
  });

  test("list/create/messages unwrap into the V1 { data } envelope", async () => {
    const { ctx, calls } = makeFakeCtx();
    const sdk = makeV2Sdk(ctx, makeCfg(agentDir), () => {});
    const listed = (await sdk.session?.list?.()) as { data: Array<{ id: string }> };
    expect(listed.data[0].id).toBe("ses_v2");
    const created = (await sdk.session?.create?.({ body: { title: "intercom ← peer" } })) as {
      data: { id: string };
    };
    expect(created.data.id).toBe("ses_created");
    expect(calls.creates).toEqual([{ title: "intercom ← peer" }]);
    const messages = (await sdk.session?.messages?.({ path: { id: "ses_v2" } })) as {
      data: Array<{ info: { role: string } }>;
    };
    expect(messages.data).toHaveLength(2);
  });

  test("model label comes from ctx.model.default() (unwraps the { data } envelope)", async () => {
    const { ctx } = makeFakeCtx();
    const sdk = makeV2Sdk(ctx, makeCfg(agentDir), () => {});
    const providers = (await sdk.config?.providers?.()) as {
      data: { default: { build?: string } };
    };
    expect(providers.data.default.build).toBe("opencode/muse-spark-1.3");
  });

  test("missing session.list degrades to undefined (bridge falls back to create)", async () => {
    const { ctx } = makeFakeCtx();
    delete ctx.session?.list;
    const sdk = makeV2Sdk(ctx, makeCfg(agentDir), () => {});
    expect(sdk.session?.list).toBeUndefined();
  });
});

describe("normalizeV2Event", () => {
  // Shapes captured from a live OpenCode v2.0.16 event stream (see PR #3).

  test("session.execution.succeeded expands to status-idle + session.idle (auto-reply trigger)", () => {
    const out = normalizeV2Event({
      type: "session.execution.succeeded",
      data: { sessionID: "ses_1" },
    });
    expect(out).toEqual([
      { type: "session.status", properties: { sessionID: "ses_1", status: "idle" } },
      { type: "session.idle", properties: { sessionID: "ses_1" } },
    ]);
  });

  test("session.execution.failed/cancelled also read as idle", () => {
    for (const type of ["session.execution.failed", "session.execution.cancelled"]) {
      const out = normalizeV2Event({ type, data: { sessionID: "ses_1" } });
      expect(out.map((e) => e.type)).toEqual(["session.status", "session.idle"]);
    }
  });

  test("session.execution.started reads as busy (presence: thinking)", () => {
    const out = normalizeV2Event({ type: "session.execution.started", data: { sessionID: "ses_1" } });
    expect(out).toEqual([{ type: "session.status", properties: { sessionID: "ses_1", status: "busy" } }]);
  });

  test("session.step.started carries the live model as message.updated", () => {
    const out = normalizeV2Event({
      type: "session.step.started",
      data: { sessionID: "ses_1", model: { providerID: "opencode", id: "muse-spark-1.3" } },
    });
    expect(out).toEqual([
      {
        type: "message.updated",
        properties: { sessionID: "ses_1", info: { providerID: "opencode", modelID: "muse-spark-1.3" } },
      },
    ]);
  });

  test("other events pass through with data as properties", () => {
    const out = normalizeV2Event({
      type: "session.inbox.enqueued",
      data: { sessionID: "ses_1", inboxID: "msg_1" },
    });
    expect(out).toEqual([
      { type: "session.inbox.enqueued", properties: { sessionID: "ses_1", inboxID: "msg_1" } },
    ]);
  });

  test("lifecycle events without a sessionID normalize to nothing", () => {
    expect(normalizeV2Event({ type: "session.execution.started", data: {} })).toEqual([]);
    expect(normalizeV2Event({ type: "session.execution.succeeded" })).toEqual([]);
    expect(normalizeV2Event({})).toEqual([]);
  });
});

describe("setupV2Intercom", () => {
  test("registers the intercom tool, presence hooks, event subscription; cleanup stops everything", async () => {
    const agentDir = tmpAgentDir();
    const pushed: Array<{ type: string; properties?: unknown }> = [];
    let signalSeen: AbortSignal | undefined;
    const events: AsyncIterable<{ type: string; properties?: unknown }> = {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          next: () =>
            index < pushed.length
              ? Promise.resolve({ value: pushed[index++], done: false })
              : new Promise(() => {}), // park like a live stream
          return: () => Promise.resolve({ value: undefined, done: true }),
        };
      },
    };
    const { ctx, calls } = makeFakeCtx(events);
    ctx.event = {
      subscribe: (options) => {
        signalSeen = options?.signal;
        return events;
      },
    };

    const originalConfig = process.env.OPENCODE_INTERCOM_CONFIG;
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.OPENCODE_INTERCOM_CONFIG = join(agentDir, "no-config.json");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const cleanup = await setupV2Intercom(ctx);
      expect(typeof cleanup).toBe("function");

      // Tool registered with the JSON Schema input surface.
      expect(calls.tools).toHaveLength(1);
      const tool = calls.tools[0];
      expect(tool.name).toBe("intercom");
      expect(tool.input.required).toEqual(["action"]);

      // Execute narrows untyped input; invalid input yields an error string.
      const bad = await tool.execute({ action: "explode" });
      expect(bad.content).toContain("unknown or missing 'action'");

      // Presence hooks registered for both phases.
      expect(calls.hooks.map((h) => h.name).sort()).toEqual(["execute.after", "execute.before"]);

      // Event subscription is live and abortable.
      expect(signalSeen).toBeInstanceOf(AbortSignal);
      expect(signalSeen?.aborted).toBe(false);
      cleanup?.();
      expect(signalSeen?.aborted).toBe(true);
    } finally {
      if (originalConfig === undefined) delete process.env.OPENCODE_INTERCOM_CONFIG;
      else process.env.OPENCODE_INTERCOM_CONFIG = originalConfig;
      if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
      rmSync(agentDir, { recursive: true, force: true });
    }
  }, 15_000);
});
