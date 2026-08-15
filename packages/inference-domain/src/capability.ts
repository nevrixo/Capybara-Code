/**
 * Provider-neutral capability vocabulary — P1-05.
 *
 * The state lattice a capability can be in, and where a capability snapshot
 * came from, are not OpenAI-specific; the OpenAI adapter builds its manifest
 * out of these.
 */

/** Version of the capability snapshot schema (§10.12). */
export const CAPABILITY_SCHEMA_VERSION = "1.0" as const;

/** Where a capability value came from. */
export type CapabilitySource = "bundled" | "provider" | "merged" | "fallback";

/** Whether a capability is usable. `unknown` is honest absence of evidence. */
export type CapabilityState = "supported" | "unsupported" | "unknown";
