// The `intercom` tool exposed to the OpenCode agent — action surface mirrors
// the omp/pi-intercom tool so orchestration prompts read the same on both sides.
//
// The "@opencode-ai/plugin" import is runtime-optional: dev builds of OpenCode
// pin a version that does not exist on npm, so the package resolves only where
// a compatible one is installed (stable builds, or the explicit dependency in
// ~/.config/opencode/package.json). A static import would kill the whole plugin
// on those builds, hence the guarded dynamic import. Without the helper the
// plugin still registers, receives and injects messages — only the
// agent-facing tool is absent.

export interface IntercomToolArgs {
  action: "list" | "list-cwd" | "send" | "ask" | "reply" | "status";
  to?: string;
  message?: string;
  replyTo?: string;
  cwd?: string;
}

export interface IntercomHubApi {
  handleTool(args: IntercomToolArgs): Promise<string>;
}

const ACTIONS = ["list", "list-cwd", "send", "ask", "reply", "status"] as const;

/** Shared description for the V1 tool() helper and the V2 tool transform. */
export const INTERCOM_TOOL_DESCRIPTION =
  "Direct messaging with other intercom sessions on this machine (omp / pi / opencode agents). " +
  '"list" shows connected sessions; "send" is fire-and-forget; "ask" blocks until the target replies ' +
  "(use for questions you cannot proceed without); \"reply\" answers a pending inbound ask; " +
  '"status" shows the local connection state.';

/** JSON Schema form of the tool input — V2 registers tools with plain JSON Schema. */
export const INTERCOM_TOOL_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    action: { type: "string", enum: [...ACTIONS], description: "Intercom action" },
    to: { type: "string", description: 'Target session name or id, e.g. "research" (send/ask)' },
    message: { type: "string", description: "Message text (send/ask/reply)" },
    replyTo: { type: "string", description: "Message id being replied to (reply; inferred when omitted)" },
    cwd: { type: "string", description: "Target the sole live session in this directory (send/ask)" },
  },
  required: ["action"],
  additionalProperties: false,
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Narrow untyped V2 tool input into IntercomToolArgs. Returns an error string
 * for a missing/unknown action so the agent sees the failure instead of a throw.
 */
export function narrowToolArgs(
  input: unknown,
): { ok: true; args: IntercomToolArgs } | { ok: false; error: string } {
  const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const action = asString(record.action);
  if (!action || !(ACTIONS as readonly string[]).includes(action)) {
    return { ok: false, error: `Error: unknown or missing 'action' (expected one of ${ACTIONS.join(", ")}).` };
  }
  return {
    ok: true,
    args: {
      action: action as IntercomToolArgs["action"],
      to: asString(record.to),
      message: asString(record.message),
      replyTo: asString(record.replyTo),
      cwd: asString(record.cwd),
    },
  };
}

/** Minimal structural view of the plugin package (it may be absent at runtime). */
interface PluginModule {
  tool: ((def: unknown) => unknown) & { schema: Record<string, (...args: unknown[]) => unknown> };
}

export async function makeIntercomTool(
  hub: IntercomHubApi,
  log: (...args: unknown[]) => void,
): Promise<unknown | null> {
  let helper: PluginModule;
  try {
    helper = (await import("@opencode-ai/plugin")) as PluginModule;
  } catch (error) {
    log(`@opencode-ai/plugin unavailable — intercom tool disabled, messaging still active (${String(error)})`);
    return null;
  }
  const s = helper.tool.schema;
  return helper.tool({
    description: INTERCOM_TOOL_DESCRIPTION,
    args: {
      action: s.enum(["list", "list-cwd", "send", "ask", "reply", "status"]).describe("Intercom action"),
      to: s.string().optional().describe('Target session name or id, e.g. "research" (send/ask)'),
      message: s.string().optional().describe("Message text (send/ask/reply)"),
      replyTo: s.string().optional().describe("Message id being replied to (reply; inferred when omitted)"),
      cwd: s.string().optional().describe("Target the sole live session in this directory (send/ask)"),
    },
    async execute(args: IntercomToolArgs) {
      return hub.handleTool(args);
    },
  });
}
