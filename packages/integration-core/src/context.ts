import { createHash } from "node:crypto";

import { IntegrationContractError } from "./errors.ts";

export interface EditorSelection {
  readonly startLine: number;
  readonly startCharacter: number;
  readonly endLine: number;
  readonly endCharacter: number;
}

export interface EditorContextAttachment {
  readonly workspaceIdentityDigest: string;
  readonly uri: string;
  readonly documentRevision: string;
  readonly languageId: string;
  readonly source: "disk" | "unsaved";
  readonly selection?: EditorSelection;
  readonly textDigest: string;
  readonly text?: string;
  readonly textOmitted: boolean;
}

export interface EditorContextPolicy {
  readonly maxTextBytes?: number;
  readonly deniedUriPatterns?: readonly RegExp[];
  readonly deniedTextPatterns?: readonly RegExp[];
}

export interface EditorContextInput {
  readonly workspaceIdentityDigest: string;
  readonly uri: string;
  readonly documentRevision: string;
  readonly languageId: string;
  readonly source: "disk" | "unsaved";
  readonly selection?: EditorSelection;
  readonly selectedText?: string;
  readonly textDigest?: string;
}

export const DEFAULT_EDITOR_CONTEXT_MAX_BYTES = 64 * 1024;

const DEFAULT_DENIED_URI_PATTERNS = [
  /(?:^|[\/])\.env(?:\.|$)/iu,
  /(?:^|[\/])(?:credentials|secrets?)(?:[.\/]|$)/iu,
  /(?:^|[\/])id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/iu,
] as const;

const DEFAULT_DENIED_TEXT_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bsk-[A-Za-z0-9_-]{20,}\b/u,
] as const;

export function createEditorContextAttachment(
  input: EditorContextInput,
  policy: EditorContextPolicy = {},
): EditorContextAttachment {
  requireText("workspaceIdentityDigest", input.workspaceIdentityDigest, 256);
  requireText("documentRevision", input.documentRevision, 256);
  requireText("languageId", input.languageId, 128);
  requireText("uri", input.uri, 4096);
  validateUri(input.uri);
  if (input.selection !== undefined) validateSelection(input.selection);

  const deniedUris = policy.deniedUriPatterns ?? DEFAULT_DENIED_URI_PATTERNS;
  if (deniedUris.some((pattern) => testPattern(pattern, input.uri))) {
    throw new IntegrationContractError(
      "INTEGRATION_CONTEXT_DENIED",
      "the editor context URI is denied by integration policy",
    );
  }
  if (
    input.selectedText !== undefined
    && (policy.deniedTextPatterns ?? DEFAULT_DENIED_TEXT_PATTERNS)
      .some((pattern) => testPattern(pattern, input.selectedText!))
  ) {
    throw new IntegrationContractError(
      "INTEGRATION_CONTEXT_DENIED",
      "the selected text is denied by integration policy",
    );
  }

  const computedDigest = input.selectedText === undefined ? undefined : digestText(input.selectedText);
  const textDigest = computedDigest ?? input.textDigest;
  if (textDigest === undefined || !/^sha256:[a-f0-9]{64}$/u.test(textDigest)) {
    throw new IntegrationContractError(
      "INTEGRATION_CONTEXT_INVALID",
      "editor context requires a sha256 text digest",
    );
  }
  if (input.textDigest !== undefined && computedDigest !== undefined && input.textDigest !== computedDigest) {
    throw new IntegrationContractError(
      "INTEGRATION_CONTEXT_INVALID",
      "selected text does not match its declared digest",
    );
  }

  const maxTextBytes = policy.maxTextBytes ?? DEFAULT_EDITOR_CONTEXT_MAX_BYTES;
  if (!Number.isSafeInteger(maxTextBytes) || maxTextBytes < 1024) {
    throw new IntegrationContractError(
      "INTEGRATION_CONTEXT_INVALID",
      "editor context maxTextBytes must be an integer of at least 1024",
    );
  }
  const includeText = input.source === "unsaved"
    && input.selectedText !== undefined
    && Buffer.byteLength(input.selectedText, "utf8") <= maxTextBytes;

  return Object.freeze({
    workspaceIdentityDigest: input.workspaceIdentityDigest,
    uri: input.uri,
    documentRevision: input.documentRevision,
    languageId: input.languageId,
    source: input.source,
    ...(input.selection === undefined ? {} : { selection: Object.freeze({ ...input.selection }) }),
    textDigest,
    ...(includeText ? { text: input.selectedText } : {}),
    textOmitted: input.selectedText !== undefined && !includeText,
  });
}

export function digestText(text: string): string {
  return "sha256:" + createHash("sha256").update(text, "utf8").digest("hex");
}

function validateSelection(selection: EditorSelection): void {
  const positions = [
    selection.startLine,
    selection.startCharacter,
    selection.endLine,
    selection.endCharacter,
  ];
  if (positions.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new IntegrationContractError(
      "INTEGRATION_CONTEXT_INVALID",
      "editor selection positions must be non-negative integers",
    );
  }
  if (
    selection.endLine < selection.startLine
    || (
      selection.endLine === selection.startLine
      && selection.endCharacter < selection.startCharacter
    )
  ) {
    throw new IntegrationContractError(
      "INTEGRATION_CONTEXT_INVALID",
      "editor selection end must not precede its start",
    );
  }
}

function validateUri(uri: string): void {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new IntegrationContractError(
      "INTEGRATION_CONTEXT_INVALID",
      "editor context URI must be absolute",
    );
  }
  if (!["file:", "untitled:", "vscode-remote:"].includes(parsed.protocol)) {
    throw new IntegrationContractError(
      "INTEGRATION_CONTEXT_INVALID",
      "editor context URI scheme is not supported",
    );
  }
}

function requireText(name: string, value: string, maxLength: number): void {
  if (value.length === 0 || value.length > maxLength || value.trim() !== value) {
    throw new IntegrationContractError(
      "INTEGRATION_CONTEXT_INVALID",
      name + " must be non-empty and bounded",
    );
  }
}

function testPattern(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}
