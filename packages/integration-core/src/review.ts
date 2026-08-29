import { IntegrationContractError } from "./errors.ts";

export type EditOperationKind = "create" | "modify" | "delete" | "rename";

export interface EditOperationProjection {
  readonly operationId: string;
  readonly kind: EditOperationKind;
  readonly path: string;
  readonly previousPath?: string;
  readonly beforeDigest?: string;
  readonly afterDigest?: string;
  readonly patch: string;
}

export interface EditReceiptProjectionInput {
  readonly receiptId: string;
  readonly status: "completed" | "partial" | "failed" | "cancelled" | "blocked";
  readonly workspaceRevisionBefore: string | number;
  readonly workspaceRevisionAfter?: string | number;
  readonly operations: readonly EditOperationProjection[];
  readonly evidenceIds?: readonly string[];
}

export interface RichDiffFile {
  readonly path: string;
  readonly operations: readonly EditOperationProjection[];
}

export interface RichDiffProjection {
  readonly receiptId: string;
  readonly files: readonly RichDiffFile[];
  readonly workspaceRevisionBefore: string | number;
  readonly workspaceRevisionAfter?: string | number;
  readonly stale: boolean;
  readonly applyAllowed: boolean;
  readonly reason?: string;
  readonly evidenceIds: readonly string[];
}

export function projectEditReceipt(
  input: EditReceiptProjectionInput,
  expectedWorkspaceRevision?: string | number,
): RichDiffProjection {
  requireText("receiptId", input.receiptId);
  if (input.operations.length === 0) {
    throw new IntegrationContractError(
      "INTEGRATION_REVIEW_INVALID",
      "an edit receipt must contain at least one operation",
    );
  }
  const operationIds = new Set<string>();
  const byFile = new Map<string, EditOperationProjection[]>();
  for (const operation of input.operations) {
    requireText("operationId", operation.operationId);
    validateRelativePath(operation.path);
    if (operation.previousPath !== undefined) validateRelativePath(operation.previousPath);
    if (operationIds.has(operation.operationId)) {
      throw new IntegrationContractError(
        "INTEGRATION_REVIEW_INVALID",
        "edit operation ids must be unique",
      );
    }
    operationIds.add(operation.operationId);
    const current = byFile.get(operation.path) ?? [];
    current.push(Object.freeze({ ...operation }));
    byFile.set(operation.path, current);
  }
  const stale = expectedWorkspaceRevision !== undefined
    && expectedWorkspaceRevision !== input.workspaceRevisionBefore;
  const completed = input.status === "completed";
  const reason = stale
    ? "workspace revision changed after the preview"
    : completed
      ? undefined
      : "only completed receipts may be applied; partial apply requires a new plan";

  return Object.freeze({
    receiptId: input.receiptId,
    files: Object.freeze(
      [...byFile.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([path, operations]) => Object.freeze({
          path,
          operations: Object.freeze(operations),
        })),
    ),
    workspaceRevisionBefore: input.workspaceRevisionBefore,
    ...(input.workspaceRevisionAfter === undefined
      ? {}
      : { workspaceRevisionAfter: input.workspaceRevisionAfter }),
    stale,
    applyAllowed: completed && !stale,
    ...(reason === undefined ? {} : { reason }),
    evidenceIds: Object.freeze([...(input.evidenceIds ?? [])]),
  });
}

export type ApprovalScope = "once" | "turn" | "session" | "project";

export interface ApprovalPresentationInput {
  readonly approvalId: string;
  readonly tool: string;
  readonly action: string;
  readonly command?: string;
  readonly cwd?: string;
  readonly readPaths?: readonly string[];
  readonly writePaths?: readonly string[];
  readonly networkDestinations?: readonly string[];
  readonly risk: string;
  readonly reason: string;
  readonly offeredScopes: readonly ApprovalScope[];
  readonly actionHash: string;
}

export interface ApprovalPresentation {
  readonly approvalId: string;
  readonly tool: string;
  readonly action: string;
  readonly command?: string;
  readonly cwd?: string;
  readonly readPaths: readonly string[];
  readonly writePaths: readonly string[];
  readonly networkDestinations: readonly string[];
  readonly risk: string;
  readonly reason: string;
  readonly offeredScopes: readonly ApprovalScope[];
  readonly actionHashPreview: string;
}

export function projectApproval(input: ApprovalPresentationInput): ApprovalPresentation {
  for (const [name, value] of [
    ["approvalId", input.approvalId],
    ["tool", input.tool],
    ["action", input.action],
    ["risk", input.risk],
    ["reason", input.reason],
    ["actionHash", input.actionHash],
  ] as const) {
    requireText(name, value);
  }
  if (input.offeredScopes.length === 0 || new Set(input.offeredScopes).size !== input.offeredScopes.length) {
    throw new IntegrationContractError(
      "INTEGRATION_REVIEW_INVALID",
      "approval scopes must be non-empty and unique",
    );
  }
  return Object.freeze({
    approvalId: input.approvalId,
    tool: input.tool,
    action: input.action,
    ...(input.command === undefined ? {} : { command: input.command }),
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    readPaths: Object.freeze([...(input.readPaths ?? [])]),
    writePaths: Object.freeze([...(input.writePaths ?? [])]),
    networkDestinations: Object.freeze([...(input.networkDestinations ?? [])]),
    risk: input.risk,
    reason: input.reason,
    offeredScopes: Object.freeze([...input.offeredScopes]),
    actionHashPreview: input.actionHash.slice(0, 18),
  });
}

function validateRelativePath(path: string): void {
  if (
    path.length === 0
    || path.includes("\0")
    || path.startsWith("/")
    || /^[A-Za-z]:[\\/]/u.test(path)
    || path.split(/[\\/]/u).includes("..")
  ) {
    throw new IntegrationContractError(
      "INTEGRATION_REVIEW_INVALID",
      "diff paths must stay relative to the workspace",
    );
  }
}

function requireText(name: string, value: string): void {
  if (value.trim().length === 0 || value.trim() !== value) {
    throw new IntegrationContractError(
      "INTEGRATION_REVIEW_INVALID",
      name + " must be non-empty",
    );
  }
}
