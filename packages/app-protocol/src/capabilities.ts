import { canonicalDigest } from "./commands.ts";
import type { AppClientRole } from "./handshake.ts";
import type { AppMethod } from "./methods.ts";

/** Capability snapshots are additive to App Protocol 1.x, but have their own schema revision. */
export const APP_CAPABILITY_SCHEMA_REVISION = "2.0" as const;

export type AppTransportKind = "local-socket" | "named-pipe" | "stdio";
export type AppMethodCapabilityState = "available" | "read-only" | "disabled" | "unsupported";

export interface AppMethodCapability {
  readonly state: AppMethodCapabilityState;
  readonly reason?: string;
  readonly requiresRole?: AppClientRole;
}

export interface AppEventCapabilities {
  readonly replay: boolean;
  readonly ack: boolean;
  readonly snapshots: boolean;
  readonly maxBatchEvents: number;
  readonly maxBatchBytes: number;
}

export interface AppPresentationCapabilities {
  readonly richDiff: boolean;
  readonly inlineApprovals: boolean;
  readonly taskTree: boolean;
  readonly planReview: boolean;
  readonly artifacts: boolean;
}

export interface AppCapabilitySnapshotBody {
  readonly protocolVersion: string;
  readonly schemaRevision: typeof APP_CAPABILITY_SCHEMA_REVISION;
  readonly serverVersion: string;
  readonly transport: AppTransportKind;
  readonly methods: Readonly<Record<AppMethod, AppMethodCapability>>;
  readonly events: AppEventCapabilities;
  readonly presentation: AppPresentationCapabilities;
}

/**
 * Immutable, connection-scoped declaration of what this host can really do.
 * The digest excludes itself and can be persisted by clients for diagnostics.
 */
export interface AppCapabilitySnapshot extends AppCapabilitySnapshotBody {
  readonly snapshotDigest: string;
}

export function finalizeCapabilitySnapshot(body: AppCapabilitySnapshotBody): AppCapabilitySnapshot {
  const methodEntries = {} as Record<AppMethod, AppMethodCapability>;
  for (const [method, capability] of Object.entries(body.methods) as Array<[AppMethod, AppMethodCapability]>) {
    methodEntries[method] = Object.freeze({ ...capability });
  }
  const methods = Object.freeze(methodEntries);
  const frozenBody: AppCapabilitySnapshotBody = Object.freeze({
    ...body,
    methods,
    events: Object.freeze({ ...body.events }),
    presentation: Object.freeze({ ...body.presentation }),
  });
  return Object.freeze({
    ...frozenBody,
    snapshotDigest: canonicalDigest(frozenBody),
  });
}
