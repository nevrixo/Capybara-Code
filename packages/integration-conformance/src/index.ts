import fixture from "../fixtures/canonical-transcript.json";

export interface CanonicalTranscript {
  readonly schemaVersion: "1.0";
  readonly messages: readonly Readonly<Record<string, unknown>>[];
}

export const CANONICAL_INTEGRATION_TRANSCRIPT = fixture as CanonicalTranscript;
