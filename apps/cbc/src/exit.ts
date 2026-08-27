/**
 * Exit codes — PRD §8.9, §13.8, AC-37, AC-38, G8.
 *
 * §8.9's table is a contract, not a convention: `capy run` is meant for CI (G8), and
 * §8.9 requires the final status event to carry the same code the process exits
 * with. A caller has to be able to distinguish "the model failed" from "approval was
 * needed and none was available" without parsing prose.
 */

export const EXIT = {
  /** Success. */
  ok: 0,
  /** Generic failure. */
  failure: 1,
  /** Invalid CLI usage. */
  usage: 2,
  /** Authentication required or failed. */
  auth: 3,
  /** Permission denied, or approval was needed and unavailable. */
  permission: 4,
  /** Provider or rate-limit failure that survived retry. */
  provider: 5,
  /** A tool or process failed. */
  tool: 6,
  /** Cancelled or interrupted. */
  cancelled: 7,
  /** Partial completion. */
  partial: 8,
  /** Configuration error. */
  config: 9,
  /** Internal protocol or runtime failure. */
  internal: 10,
  /** Internal launcher handoff: install the selected exact release after this binary exits. */
  updateHandoff: 42,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export const EXIT_DESCRIPTIONS: Readonly<Record<number, string>> = {
  0: "success",
  1: "generic failure",
  2: "invalid CLI usage",
  3: "authentication required or failed",
  4: "permission denied or approval unavailable",
  5: "provider or rate-limit failure after retry",
  6: "tool or process failure",
  7: "task cancelled or interrupted",
  8: "partial completion",
  9: "configuration error",
  10: "internal protocol or runtime failure",
  42: "internal package-manager update handoff",
};

/**
 * Map a completion status onto its exit code.
 *
 * §8.9 pairs `partial` with code 8 rather than folding it into failure, because a
 * partial result may still be useful to a caller — the distinction is the point.
 */
export function exitForStatus(
  status: "completed" | "partial" | "failed" | "cancelled",
): ExitCode {
  switch (status) {
    case "completed":
      return EXIT.ok;
    case "partial":
      return EXIT.partial;
    case "cancelled":
      return EXIT.cancelled;
    case "failed":
      return EXIT.failure;
  }
}

/** A failure carrying the §8.9 code it should exit with. */
export class CliError extends Error {
  readonly code: ExitCode;
  /** Extra lines printed after the message, e.g. what to try instead. */
  readonly detail: readonly string[];

  constructor(code: ExitCode, message: string, detail: readonly string[] = []) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.detail = detail;
  }
}

export function usageError(message: string, detail: readonly string[] = []): CliError {
  return new CliError(EXIT.usage, message, detail);
}

export function configError(message: string, detail: readonly string[] = []): CliError {
  return new CliError(EXIT.config, message, detail);
}

export function authError(message: string, detail: readonly string[] = []): CliError {
  return new CliError(EXIT.auth, message, detail);
}
