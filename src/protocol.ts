// Intercom broker wire types and boundary assert — wire-identical to
// omp-intercom / pi-intercom protocol v1 (broker/protocol.ts + types.ts).

export interface Attachment {
  type: "file" | "snippet" | "context";
  name: string;
  content: string;
  language?: string;
}

export interface Message {
  id: string;
  timestamp: number;
  senderSequence?: number;
  brokerReceivedAt?: number;
  brokerDeliveredAt?: number;
  receiverReceivedAt?: number;
  injectedAt?: number;
  supersedes?: string;
  retryOf?: string;
  replyTo?: string;
  expectsReply?: boolean;
  content: {
    text: string;
    attachments?: Attachment[];
  };
}

export type MessageReceiptStatus =
  | "receiver_received"
  | "queued"
  | "injected"
  | "acknowledged"
  | "expired"
  | "cancelled"
  | "superseded"
  | "cancellation_requested";

export interface MessageReceipt {
  messageId: string;
  status: MessageReceiptStatus;
  timestamp: number;
  detail?: string;
}

export interface SessionInfo {
  id: string;
  endpointEpoch?: string;
  name?: string;
  runtimeFallbackAlias?: boolean;
  cwd: string;
  model: string;
  pid: number;
  startedAt: number;
  lastActivity: number;
  status?: string;
  peerUid?: number;
  trustedLocal?: boolean;
  contextPct?: number;
  contextTokens?: number;
  contextWindow?: number;
  tmuxPane?: string;
  /** Harness this session runs on ("pi" | "omp" | "opencode"). Additive;
   *  older peers simply ignore it. */
  harness?: string;
  /** Delivery capabilities advertised by the session. Absent on older clients. */
  capabilities?: {
    steer?: boolean;
    ask?: boolean;
    ui?: boolean;
    attachments?: boolean;
  };
}

export type SessionRegistration = Omit<SessionInfo, "id" | "endpointEpoch" | "peerUid" | "trustedLocal">;

export type ClientMessage =
  | { type: "register"; session: SessionRegistration; sessionId?: string; stateId?: string; scopeId?: string }
  | { type: "unregister" }
  | { type: "list"; requestId: string }
  | { type: "send"; to: string; message: Message; targetId?: string; targetEpoch?: string }
  | { type: "message_receipt"; receipt: MessageReceipt }
  | { type: "cancel_message"; messageId: string }
  | { type: "cancel_ask"; messageId: string }
  | {
      type: "presence";
      name?: string;
      runtimeFallbackAlias?: boolean;
      status?: string;
      model?: string;
      contextPct?: number | null;
      contextTokens?: number | null;
      contextWindow?: number | null;
    };

export type DeliveryState = "socket_delivered" | "queued" | "failed" | "unknown";

export interface DeliveryDetails {
  delivery: DeliveryState;
  code?: string;
  retryable: boolean;
  outcomeKnown: boolean;
}

export type BrokerMessage =
  | { type: "registered"; sessionId: string; features?: string[] }
  | { type: "sessions"; requestId: string; sessions: SessionInfo[] }
  | { type: "message"; from: SessionInfo; message: Message }
  | { type: "presence_update"; session: SessionInfo }
  | { type: "session_joined"; session: SessionInfo }
  | { type: "session_left"; sessionId: string }
  | { type: "error"; error: string }
  | ({ type: "delivered"; messageId: string } & DeliveryDetails)
  | ({ type: "delivery_failed"; messageId: string; reason: string } & DeliveryDetails)
  | { type: "message_receipt"; from: SessionInfo; receipt: MessageReceipt }
  | { type: "message_control"; from: SessionInfo; control: unknown };

/** Single boundary assert for frames read off the broker socket. */
export function asBrokerMessage(value: unknown): BrokerMessage | null {
  if (typeof value !== "object" || value === null || !("type" in value) || typeof value.type !== "string") {
    return null;
  }
  return value as BrokerMessage;
}
