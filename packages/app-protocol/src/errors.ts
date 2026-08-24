/**
 * Stable, transport-safe errors for the client-facing App Protocol.
 *
 * Runtime RPC errors deliberately do not cross this boundary unchanged: callers
 * need a retry decision and useful conflict data, but never a sidecar stack trace
 * or an incidental local path.
 */

export type StructuredErrorCategory =
  | "validation"
  | "conflict"
  | "permission"
  | "not_found"
  | "unavailable"
  | "timeout"
  | "resource_limit"
  | "protocol"
  | "provider"
  | "internal";

export interface StructuredError {
  readonly code: string;
  readonly category: StructuredErrorCategory;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  readonly evidenceIds?: readonly string[];
}

export class AppProtocolError extends Error {
  readonly structured: StructuredError;

  constructor(structured: StructuredError) {
    super(structured.message);
    this.name = "AppProtocolError";
    this.structured = structured;
  }
}

export function structuredError(
  code: string,
  category: StructuredErrorCategory,
  message: string,
  options: {
    readonly retryable?: boolean;
    readonly details?: Record<string, unknown>;
    readonly evidenceIds?: readonly string[];
  } = {},
): StructuredError {
  return {
    code,
    category,
    message,
    retryable: options.retryable ?? false,
    ...(options.details === undefined ? {} : { details: options.details }),
    ...(options.evidenceIds === undefined ? {} : { evidenceIds: options.evidenceIds }),
  };
}
