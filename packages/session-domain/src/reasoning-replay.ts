/** Domain-neutral replay contract for persisted provider response items. */

export interface OpaqueReasoningReference {
  readonly itemId: string;
  readonly sequence: number;
  readonly opaque: string;
  readonly summaryText?: string;
}

export interface ReasoningReplayPlan {
  readonly continuity: "previous_response" | "all_items" | "current_turn";
  readonly previousResponseId?: string;
  readonly opaqueItems: readonly OpaqueReasoningReference[];
  readonly exportOpaque: false;
}

export function createReasoningReplayPlan(input: {
  readonly previousResponseId?: string;
  readonly providerContinuationAvailable?: boolean;
  readonly opaqueItems?: readonly OpaqueReasoningReference[];
  readonly reviewer?: boolean;
} = {}): ReasoningReplayPlan {
  if (input.previousResponseId !== undefined && input.providerContinuationAvailable === true && input.reviewer !== true) {
    return { continuity: "previous_response", previousResponseId: input.previousResponseId, opaqueItems: [], exportOpaque: false };
  }
  return {
    continuity: input.reviewer === true ? "current_turn" : "all_items",
    opaqueItems: [...(input.opaqueItems ?? [])],
    exportOpaque: false,
  };
}
