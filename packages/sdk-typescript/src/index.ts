/**
 * `@cbc/sdk` — client-facing App Protocol SDK.
 */

export {
  CapybaraClient,
  type ConnectOptions,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcTransport,
  type TransportKind,
} from "./client.ts";

export {
  Session,
  type RpcCaller,
  type SessionOptions,
  type SubmitOptions,
  type TurnHandle,
  type WaitOptions,
} from "./session.ts";

export {
  EventStream,
  type EventStreamOptions,
  type StreamEvent,
} from "./stream.ts";

export {
  resolveApproval,
  type ApprovalDecision,
  type ApprovalHandler,
  type ApprovalHooks,
  type ApprovalRequest,
} from "./approvals.ts";

export {
  createUnixTransport,
  type UnixJsonRpcTransport,
} from "./unix.ts";

export {
  SDK_APP_METHODS,
  SDK_EVENT_KINDS,
  SDK_EVENT_SCHEMA_VERSION,
  SDK_PROTOCOL_VERSION,
  type SdkAppMethod,
  type SdkEventKind,
} from "./generated.ts";
