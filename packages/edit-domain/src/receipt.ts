import { EDIT_SCHEMA_VERSION } from "./types.ts";
import type {
  EditPlanId,
  EditReceiptId,
  PreparedFileChange,
  ResolvedTextEdit,
} from "./types.ts";

export type EditReceiptStatus =
  | "previewed"
  | "staged"
  | "committed"
  | "conflicted"
  | "failed";

/** Durable receipt of a previewed or staged edit plan. Full file text is omitted. */
export interface EditReceipt {
  readonly schemaVersion: typeof EDIT_SCHEMA_VERSION;
  readonly id: EditReceiptId;
  readonly planId: EditPlanId;
  readonly planDigest: string;
  readonly status: EditReceiptStatus;
  readonly createdAt: string;
  readonly transactionId?: string;
  readonly files?: readonly Omit<PreparedFileChange, "text">[];
  readonly resolvedOperations?: readonly Omit<ResolvedTextEdit, "replacement">[];
}
