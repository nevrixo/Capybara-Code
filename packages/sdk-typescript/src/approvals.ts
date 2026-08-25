/**
 * Approval callback contracts for interactive App Protocol sessions.
 */

export interface ApprovalRequest {
  readonly approvalId: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly kind: string;
  readonly summary: string;
  readonly risk?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type ApprovalDecision =
  | { readonly decision: "allow" | "allow_once" | "deny"; readonly reason?: string }
  | { readonly decision: "allow_session"; readonly reason?: string };

export type ApprovalHandler = (
  request: ApprovalRequest,
) => ApprovalDecision | Promise<ApprovalDecision>;

export interface ApprovalHooks {
  readonly onApproval?: ApprovalHandler;
}

export async function resolveApproval(
  hooks: ApprovalHooks | undefined,
  request: ApprovalRequest,
): Promise<ApprovalDecision> {
  const handler = hooks?.onApproval;
  if (handler === undefined) {
    return { decision: "deny", reason: "no approval handler registered" };
  }
  return handler(request);
}
