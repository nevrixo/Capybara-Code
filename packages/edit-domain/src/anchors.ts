import { createHash } from "node:crypto";

import {
  lineNumberAtByteOffset,
  logicalLines,
  rangeToByteRange,
  substringAtByteRange,
  utf16IndexToByteOffset,
} from "./position.ts";
import { EditDomainError } from "./types.ts";
import type {
  ByteRange,
  ConflictPolicy,
  ContextAnchor,
  EditAnchor,
  ExactTextAnchor,
  ResolutionEvidence,
  SymbolAnchor,
} from "./types.ts";

export interface AnchorResolution {
  readonly byteRange: ByteRange;
  readonly evidence: ResolutionEvidence;
}

export interface AnchorResolutionOptions {
  readonly conflictPolicy: ConflictPolicy;
  readonly currentRevision: string;
  readonly maxCandidates?: number;
  readonly ambiguityMargin?: number;
  readonly path?: string;
  readonly operationId?: string;
}

interface Candidate {
  readonly byteRange: ByteRange;
  readonly score: number;
}

const DEFAULT_MAX_CANDIDATES = 32;
const DEFAULT_AMBIGUITY_MARGIN = 5;

/** SHA-256 over exact UTF-8 text, distinct from canonical JSON object digests. */
export function textDigest(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/**
 * Resolve only exact, bounded textual evidence. Symbol anchors are deliberately
 * fail-closed unless a trusted producer supplied a context fallback.
 */
export function resolveAnchor(
  text: string,
  anchor: EditAnchor,
  options: AnchorResolutionOptions,
): AnchorResolution {
  switch (anchor.kind) {
    case "exact_text":
      return resolveExactTextAnchor(text, anchor, options);
    case "context":
      return resolveContextAnchor(text, anchor, options);
    case "symbol":
      return resolveSymbolAnchor(text, anchor, options);
  }
}

function resolveExactTextAnchor(
  text: string,
  anchor: ExactTextAnchor,
  options: AnchorResolutionOptions,
): AnchorResolution {
  if (anchor.originalText.length === 0) {
    throw failure(options, "EDIT_ANCHOR_NOT_FOUND", "exact text anchors must not be empty");
  }
  if (textDigest(anchor.originalText) !== anchor.originalTextDigest) {
    throw failure(options, "EDIT_TOKEN_INVALID", "exact anchor text does not match its digest");
  }
  const expected = anchor.expectedRange === undefined
    ? undefined
    : rangeToByteRange(text, anchor.expectedRange);
  const revisionMatches = anchor.baseRevision === options.currentRevision;

  if (revisionMatches && expected !== undefined) {
    const observed = substringAtByteRange(text, expected);
    if (observed === anchor.originalText) {
      return resolved(expected, "expected_range", 160, 1, anchor.baseRevision, options.currentRevision);
    }
  }
  if (!revisionMatches && options.conflictPolicy === "fail") {
    throw failure(options, "EDIT_REVISION_MISMATCH", "anchor base revision does not match the current document");
  }

  const candidates = exactCandidates(text, anchor.originalText, options);
  if (candidates.length === 0) {
    throw failure(options, "EDIT_ANCHOR_NOT_FOUND", "exact anchor text was not found");
  }
  if (expected !== undefined) {
    const expectedCandidate = candidates.find((candidate) => sameRange(candidate.byteRange, expected));
    if (expectedCandidate !== undefined) {
      return resolved(
        expectedCandidate.byteRange,
        "expected_range",
        150,
        candidates.length,
        anchor.baseRevision,
        options.currentRevision,
      );
    }
  }
  if (candidates.length === 1) {
    const candidate = candidates[0];
    if (candidate === undefined) throw new Error("unreachable candidate lookup");
    return resolved(
      candidate.byteRange,
      "exact_text",
      candidate.score,
      1,
      anchor.baseRevision,
      options.currentRevision,
    );
  }

  // `occurrence` remains a useful diagnosis hint but cannot turn duplicated text
  // into a write target without independent range/context evidence.
  const occurrenceDetail = anchor.occurrence === undefined
    ? ""
    : ` (occurrence hint ${anchor.occurrence})`;
  throw failure(
    options,
    "EDIT_ANCHOR_AMBIGUOUS",
    `exact anchor has ${candidates.length} candidates${occurrenceDetail}`,
  );
}

function resolveContextAnchor(
  text: string,
  anchor: ContextAnchor,
  options: AnchorResolutionOptions,
): AnchorResolution {
  if (anchor.targetPreview === undefined || anchor.targetPreview.length === 0) {
    throw failure(
      options,
      "EDIT_ANCHOR_NOT_FOUND",
      "context anchor requires a bounded full targetPreview in the initial rollout",
    );
  }
  if (textDigest(anchor.targetPreview) !== anchor.targetDigest) {
    throw failure(options, "EDIT_TOKEN_INVALID", "context targetPreview does not match targetDigest");
  }
  if (anchor.baseRevision !== options.currentRevision && options.conflictPolicy === "fail") {
    throw failure(options, "EDIT_REVISION_MISMATCH", "anchor base revision does not match the current document");
  }

  const lines = logicalLines(text);
  const candidates = exactCandidates(text, anchor.targetPreview, options).map((candidate) => ({
    ...candidate,
    score: scoreContextCandidate(text, lines, candidate.byteRange, anchor),
  }));
  if (candidates.length === 0) {
    throw failure(options, "EDIT_ANCHOR_NOT_FOUND", "context anchor target was not found");
  }
  candidates.sort((left, right) => right.score - left.score || left.byteRange.start - right.byteRange.start);
  const best = candidates[0];
  const second = candidates[1];
  if (best === undefined) throw new Error("unreachable candidate lookup");
  const margin = options.ambiguityMargin ?? DEFAULT_AMBIGUITY_MARGIN;
  if (second !== undefined && best.score - second.score < margin) {
    throw failure(
      options,
      "EDIT_ANCHOR_AMBIGUOUS",
      `context anchor candidates are too close (${best.score} vs ${second.score})`,
    );
  }
  return resolved(
    best.byteRange,
    "context",
    best.score,
    candidates.length,
    anchor.baseRevision,
    options.currentRevision,
  );
}

function resolveSymbolAnchor(
  text: string,
  anchor: SymbolAnchor,
  options: AnchorResolutionOptions,
): AnchorResolution {
  if (anchor.fallbackContext === undefined) {
    throw failure(
      options,
      "EDIT_TOKEN_INVALID",
      "symbol anchors require a trusted local range receipt or a context fallback",
    );
  }
  const fallback = resolveContextAnchor(text, anchor.fallbackContext, options);
  return {
    byteRange: fallback.byteRange,
    evidence: { ...fallback.evidence, method: "symbol_fallback" },
  };
}

function exactCandidates(
  text: string,
  target: string,
  options: AnchorResolutionOptions,
): readonly Candidate[] {
  const max = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const positions = findOccurrences(text, target, max + 1);
  if (positions.length > max) {
    throw failure(options, "EDIT_ANCHOR_AMBIGUOUS", `anchor exceeds ${max} candidate search bound`);
  }
  return positions.map((startIndex) => {
    const endIndex = startIndex + target.length;
    return {
      byteRange: {
        start: utf16IndexToByteOffset(text, startIndex),
        end: utf16IndexToByteOffset(text, endIndex),
      },
      score: 100,
    };
  });
}

function findOccurrences(text: string, target: string, max: number): readonly number[] {
  const positions: number[] = [];
  let from = 0;
  while (from <= text.length) {
    const found = text.indexOf(target, from);
    if (found < 0) break;
    positions.push(found);
    if (positions.length >= max) break;
    from = found + 1;
  }
  return positions;
}

function scoreContextCandidate(
  text: string,
  lines: readonly string[],
  range: ByteRange,
  anchor: ContextAnchor,
): number {
  let score = 100;
  const startLine = lineNumberAtByteOffset(text, range.start) - 1;
  const endLine = lineNumberAtByteOffset(text, range.end) - 1;
  if (contextMatches(lines, startLine - anchor.before.length, anchor.before, anchor.whitespacePolicy)) {
    score += 30;
  }
  if (contextMatches(lines, endLine + 1, anchor.after, anchor.whitespacePolicy)) {
    score += 30;
  }
  if (anchor.approximateLine !== undefined) {
    const distance = Math.abs(startLine + 1 - anchor.approximateLine);
    if (distance <= 5) score += 15;
    else if (distance <= 20) score += 8;
  }
  if (anchor.whitespacePolicy === "normalize_indent") score += 5;
  return score;
}

function contextMatches(
  lines: readonly string[],
  start: number,
  expected: readonly string[],
  policy: ContextAnchor["whitespacePolicy"],
): boolean {
  if (expected.length === 0) return false;
  if (start < 0 || start + expected.length > lines.length) return false;
  return expected.every((value, index) => normalize(lines[start + index] ?? "", policy) === normalize(value, policy));
}

function normalize(value: string, policy: ContextAnchor["whitespacePolicy"]): string {
  switch (policy) {
    case "exact":
      return value;
    case "normalize_eol":
      return value.replace(/\r\n?/gu, "\n");
    case "normalize_indent":
      return value.replace(/^\s+/u, "").replace(/\r\n?/gu, "\n");
  }
}

function resolved(
  byteRange: ByteRange,
  method: ResolutionEvidence["method"],
  score: number,
  candidateCount: number,
  baseRevision: string,
  currentRevision: string,
): AnchorResolution {
  return {
    byteRange,
    evidence: { method, score, candidateCount, baseRevision, currentRevision },
  };
}

function sameRange(left: ByteRange, right: ByteRange): boolean {
  return left.start === right.start && left.end === right.end;
}

function failure(
  options: AnchorResolutionOptions,
  code: EditDomainError["code"],
  message: string,
): EditDomainError {
  return new EditDomainError(
    code,
    message,
    {
      ...(options.path === undefined ? {} : { path: options.path }),
      ...(options.operationId === undefined ? {} : { operationId: options.operationId }),
    },
  );
}
