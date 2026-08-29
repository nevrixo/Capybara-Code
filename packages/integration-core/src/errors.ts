export type IntegrationErrorCode =
  | "INTEGRATION_STATE_INVALID"
  | "INTEGRATION_CURSOR_INVALID"
  | "INTEGRATION_REPLAY_CONFLICT"
  | "INTEGRATION_CONTEXT_DENIED"
  | "INTEGRATION_CONTEXT_INVALID"
  | "INTEGRATION_REVIEW_INVALID"
  | "INTEGRATION_TRIGGER_INVALID";

export class IntegrationContractError extends Error {
  readonly code: IntegrationErrorCode;

  constructor(code: IntegrationErrorCode, message: string) {
    super(message);
    this.name = "IntegrationContractError";
    this.code = code;
  }
}
