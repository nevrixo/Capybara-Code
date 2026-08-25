/**
 * Daemon-owned approval queue. Pending approvals survive client detach and are
 * only resolved by an explicit, idempotent decision.
 */

export type ApprovalState = "pending" | "resolved" | "expired" | "cancelled";

export type ApprovalDecision =
  | { readonly kind: "allow_once" }
  | { readonly kind: "allow_session" }
  | { readonly kind: "deny"; readonly reason: string };

export interface ApprovalRequest {
  readonly title: string;
  readonly summary: string;
  readonly risk?: string;
  readonly network?: boolean;
  readonly paths?: readonly string[];
  readonly actionHash: string;
}

export interface PendingApproval {
  readonly approvalId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly actionHash: string;
  readonly request: ApprovalRequest;
  readonly state: ApprovalState;
  readonly requestedAt: string;
  readonly expiresAt?: string;
  readonly resolvedByClientId?: string;
  readonly decision?: ApprovalDecision;
}

export interface ApprovalManagerOptions {
  readonly now?: () => string;
}

export class ApprovalManagerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ApprovalManagerError";
    this.code = code;
  }
}

export class ApprovalManager {
  readonly #now: () => string;
  readonly #approvals = new Map<string, PendingApproval>();

  constructor(options: ApprovalManagerOptions = {}) {
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  request(input: {
    readonly approvalId: string;
    readonly sessionId: string;
    readonly turnId: string;
    readonly request: ApprovalRequest;
    readonly expiresAt?: string;
  }): PendingApproval {
    const existing = this.#approvals.get(input.approvalId);
    if (existing !== undefined) {
      if (existing.actionHash !== input.request.actionHash) {
        throw new ApprovalManagerError(
          "APPROVAL_ID_REUSED",
          "approval id reused with a different action hash",
        );
      }
      return existing;
    }
    if (input.request.actionHash.trim().length === 0) {
      throw new ApprovalManagerError("APPROVAL_INVALID", "actionHash is required");
    }
    const record: PendingApproval = {
      approvalId: input.approvalId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      actionHash: input.request.actionHash,
      request: input.request,
      state: "pending",
      requestedAt: this.#now(),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    };
    this.#approvals.set(record.approvalId, record);
    return record;
  }

  get(approvalId: string): PendingApproval | undefined {
    return this.#approvals.get(approvalId);
  }

  list(sessionId?: string): readonly PendingApproval[] {
    const values = [...this.#approvals.values()];
    return sessionId === undefined
      ? values
      : values.filter((approval) => approval.sessionId === sessionId);
  }

  listPending(sessionId?: string): readonly PendingApproval[] {
    return this.list(sessionId).filter((approval) => approval.state === "pending");
  }

  resolve(input: {
    readonly approvalId: string;
    readonly clientId: string;
    readonly actionHash: string;
    readonly decision: ApprovalDecision;
  }): PendingApproval {
    const existing = this.#approvals.get(input.approvalId);
    if (existing === undefined) {
      throw new ApprovalManagerError("APPROVAL_NOT_FOUND", "unknown approval");
    }
    if (existing.actionHash !== input.actionHash) {
      throw new ApprovalManagerError(
        "APPROVAL_ACTION_MISMATCH",
        "resolve action hash does not match the pending request",
      );
    }
    if (existing.state === "resolved") {
      if (sameDecision(existing.decision, input.decision)) return existing;
      throw new ApprovalManagerError(
        "APPROVAL_ALREADY_RESOLVED",
        "approval was already resolved with a different decision",
      );
    }
    if (existing.state !== "pending") {
      throw new ApprovalManagerError(
        "APPROVAL_NOT_PENDING",
        `approval is ${existing.state}`,
      );
    }
    const resolved: PendingApproval = {
      ...existing,
      state: "resolved",
      resolvedByClientId: input.clientId,
      decision: input.decision,
    };
    this.#approvals.set(resolved.approvalId, resolved);
    return resolved;
  }

  cancel(approvalId: string): PendingApproval {
    const existing = this.#approvals.get(approvalId);
    if (existing === undefined) {
      throw new ApprovalManagerError("APPROVAL_NOT_FOUND", "unknown approval");
    }
    if (existing.state === "cancelled") return existing;
    if (existing.state !== "pending") {
      throw new ApprovalManagerError(
        "APPROVAL_NOT_PENDING",
        `approval is ${existing.state}`,
      );
    }
    const cancelled: PendingApproval = { ...existing, state: "cancelled" };
    this.#approvals.set(approvalId, cancelled);
    return cancelled;
  }
}

function sameDecision(
  left: ApprovalDecision | undefined,
  right: ApprovalDecision,
): boolean {
  if (left === undefined) return false;
  if (left.kind !== right.kind) return false;
  if (left.kind === "deny" && right.kind === "deny") return left.reason === right.reason;
  return true;
}
