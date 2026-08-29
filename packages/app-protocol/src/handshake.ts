import { AppProtocolError, structuredError } from "./errors.ts";
import type { AppCapabilitySnapshot } from "./capabilities.ts";

export const APP_PROTOCOL_VERSION = "1.0" as const;

export type AppClientKind = "tui" | "cli" | "ide" | "sdk" | "ci" | "plugin-host";
export type AppClientRole = "observer" | "controller" | "approval_resolver" | "administrator-local";

export interface AppInitializeParams {
  readonly protocolVersion: string;
  readonly client: {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly kind: AppClientKind;
  };
  readonly capabilities: {
    readonly eventStreaming: boolean;
    readonly eventAck: boolean;
    readonly approvals: boolean;
    readonly interactivePrompts: boolean;
    readonly artifactStreaming: boolean;
    readonly richDiff: boolean;
    readonly taskTree?: boolean;
    readonly planReview?: boolean;
  };
  readonly authentication?: { readonly challengeResponse?: string };
}

export interface AppServerLimits {
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly maxSubscriptionsPerClient: number;
  readonly maxSessionsPerSubscription: number;
}

export interface AppInitializeResult {
  readonly protocolVersion: string;
  readonly serverVersion: string;
  readonly daemonId: string;
  readonly connectionId: string;
  readonly capabilities: Readonly<Record<string, boolean | string | number>>;
  readonly capabilitySnapshot: AppCapabilitySnapshot;
  readonly limits: AppServerLimits;
}

export function negotiateAppProtocol(clientVersion: string, serverVersion = APP_PROTOCOL_VERSION): string {
  const clientMajor = clientVersion.split(".", 1)[0];
  const serverMajor = serverVersion.split(".", 1)[0];
  if (clientMajor !== serverMajor) {
    throw new AppProtocolError(structuredError(
      "APP_PROTOCOL_VERSION_MISMATCH",
      "protocol",
      `client protocol ${clientVersion} is incompatible with server protocol ${serverVersion}`,
      { details: { clientVersion, serverVersion } },
    ));
  }
  return serverVersion;
}
