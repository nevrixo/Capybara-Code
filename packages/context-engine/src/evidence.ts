import { createHash } from "node:crypto";

/**
 * Identity-aware evidence ledger for context selection and hosted read-only
 * agents. Evidence is a claim about an observation, never a hidden reasoning
 * transcript. Compaction keeps references and digests so a later turn can
 * revalidate before using a claim.
 */

export type EvidenceKind =
  | "file_excerpt"
  | "test_result"
  | "tool_observation"
  | "repository_map"
  | "review_finding"
  | "external_provenance";

export type EvidenceFreshness = "fresh" | "stale" | "invalid" | "unknown";

export interface EvidenceRecord {
  readonly id: `evidence-${string}`;
  readonly kind: EvidenceKind;
  readonly locator: string;
  readonly digest: string;
  readonly workspaceIdentityDigest?: string;
  readonly externalProvenance?: {
    readonly source: string;
    readonly uri?: string;
    readonly retrievedAt?: string;
    readonly citation?: string;
  };
  readonly observedAt: string;
  readonly freshness: EvidenceFreshness;
  readonly summary: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
  readonly invalidatedAt?: string;
  readonly invalidationReason?: string;
}

export interface EvidenceInput {
  readonly id?: `evidence-${string}`;
  readonly kind: EvidenceKind;
  readonly locator: string;
  readonly digest?: string;
  readonly workspaceIdentityDigest?: string;
  readonly externalProvenance?: EvidenceRecord["externalProvenance"];
  readonly observedAt?: string;
  readonly summary: string;
  readonly metadata?: EvidenceRecord["metadata"];
}

export interface EvidenceSelection {
  readonly records: readonly EvidenceRecord[];
  readonly omitted: number;
  readonly rejected: readonly { id: string; reason: string }[];
}

export interface EvidenceReference {
  readonly id: string;
  readonly kind: EvidenceKind;
  readonly locator: string;
  readonly digest: string;
}

export interface EvidenceCapsule {
  readonly capsuleId: `capsule-${string}`;
  readonly workspaceIdentityDigest?: string;
  readonly evidenceIds: readonly `evidence-${string}`[];
  readonly references: readonly EvidenceReference[];
  readonly claims: readonly string[];
  readonly sourceAgentId: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly digest: string;
}

export interface EvidenceLedgerOptions {
  readonly workspaceIdentityDigest?: string;
  readonly now?: () => string;
  readonly maxRecords?: number;
}

export interface EvidenceSelectOptions {
  readonly ids?: readonly `evidence-${string}`[];
  readonly kinds?: readonly EvidenceKind[];
  readonly limit?: number;
  readonly requireFresh?: boolean;
  readonly workspaceIdentityDigest?: string;
}

export class EvidenceLedger {
  readonly #records = new Map<`evidence-${string}`, EvidenceRecord>();
  readonly #now: () => string;
  readonly #maxRecords: number;
  #workspaceIdentityDigest: string | undefined;

  constructor(options: EvidenceLedgerOptions = {}) {
    this.#workspaceIdentityDigest = options.workspaceIdentityDigest;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#maxRecords = Math.max(1, Math.floor(options.maxRecords ?? 2_048));
  }

  get workspaceIdentityDigest(): string | undefined {
    return this.#workspaceIdentityDigest;
  }

  setWorkspaceIdentity(identityDigest: string | undefined): number {
    this.#workspaceIdentityDigest = identityDigest;
    return this.invalidateForIdentity(identityDigest);
  }

  record(input: EvidenceInput): EvidenceRecord {
    const observedAt = input.observedAt ?? this.#now();
    const workspaceIdentityDigest =
      input.workspaceIdentityDigest ?? this.#workspaceIdentityDigest;
    const digest = input.digest ?? stableDigest({
      kind: input.kind,
      locator: input.locator,
      summary: input.summary,
      metadata: input.metadata,
      workspaceIdentityDigest,
    });
    // Exact evidence identity deliberately excludes observation time. A cache hit
    // is another provenance observation of the same fact, not a second fact in
    // the next prompt.
    const id = input.id ?? (`evidence-${stableDigest({
      kind: input.kind,
      locator: input.locator,
      digest,
      workspaceIdentityDigest,
    })}` as `evidence-${string}`);
    const previous = this.#records.get(id);
    const metadata: Record<string, string | number | boolean> = {
      ...(previous?.metadata ?? {}),
      ...(input.metadata ?? {}),
      observationCount:
        typeof previous?.metadata?.observationCount === "number"
          ? previous.metadata.observationCount + 1
          : 1,
    };
    const record: EvidenceRecord = {
      id,
      kind: input.kind,
      locator: input.locator,
      digest,
      ...(workspaceIdentityDigest !== undefined ? { workspaceIdentityDigest } : {}),
      ...(input.externalProvenance !== undefined ? { externalProvenance: input.externalProvenance } : {}),
      observedAt,
      freshness: this.isIdentityCompatible(workspaceIdentityDigest) ? "fresh" : "stale",
      summary: input.summary.slice(0, 2_000),
      metadata,
    };
    this.#records.set(id, record);
    this.trim();
    return record;
  }

  get(id: `evidence-${string}`): EvidenceRecord | undefined {
    return this.#records.get(id);
  }

  all(): readonly EvidenceRecord[] {
    return [...this.#records.values()].sort(compareEvidence);
  }

  invalidate(id: `evidence-${string}`, reason = "invalidated", now = this.#now()): boolean {
    const current = this.#records.get(id);
    if (current === undefined) return false;
    this.#records.set(id, {
      ...current,
      freshness: "invalid",
      invalidatedAt: now,
      invalidationReason: reason,
    });
    return true;
  }

  /** Invalidate every record matching a path/locator predicate. */
  invalidateWhere(
    predicate: (record: EvidenceRecord) => boolean,
    reason = "invalidated",
    now = this.#now(),
  ): EvidenceRecord[] {
    const invalidated: EvidenceRecord[] = [];
    for (const record of this.#records.values()) {
      if (!predicate(record) || record.freshness === "invalid") continue;
      const next: EvidenceRecord = {
        ...record,
        freshness: "invalid",
        invalidatedAt: now,
        invalidationReason: reason,
      };
      this.#records.set(record.id, next);
      invalidated.push(next);
    }
    return invalidated;
  }

  invalidateLocator(
    locator: string,
    reason = "locator invalidated",
    options: { readonly prefix?: boolean } = {},
  ): EvidenceRecord[] {
    return this.invalidateWhere(
      (record) => options.prefix === true
        ? record.locator === locator || record.locator.startsWith(`${locator}#`)
        : record.locator === locator,
      reason,
    );
  }

  invalidateForIdentity(identityDigest: string | undefined, now = this.#now()): number {
    let invalidated = 0;
    for (const [id, record] of this.#records) {
      if (identityDigest !== undefined && record.workspaceIdentityDigest === identityDigest) continue;
      if (record.workspaceIdentityDigest === undefined) continue;
      if (record.freshness === "invalid") continue;
      this.#records.set(id, {
        ...record,
        freshness: "stale",
        invalidatedAt: now,
        invalidationReason: "workspace identity changed",
      });
      invalidated += 1;
    }
    return invalidated;
  }

  select(options: EvidenceSelectOptions = {}): EvidenceSelection {
    const ids = options.ids === undefined ? undefined : new Set(options.ids);
    const kinds = options.kinds === undefined ? undefined : new Set(options.kinds);
    const identity = options.workspaceIdentityDigest ?? this.#workspaceIdentityDigest;
    const requireFresh = options.requireFresh !== false;
    const limit = Math.max(0, Math.floor(options.limit ?? Number.MAX_SAFE_INTEGER));
    const records: EvidenceRecord[] = [];
    const rejected: Array<{ id: string; reason: string }> = [];
    for (const record of this.all()) {
      if (ids !== undefined && !ids.has(record.id)) continue;
      if (kinds !== undefined && !kinds.has(record.kind)) continue;
      if (identity !== undefined && record.workspaceIdentityDigest !== undefined && record.workspaceIdentityDigest !== identity) {
        rejected.push({ id: record.id, reason: "workspace identity mismatch" });
        continue;
      }
      if (requireFresh && record.freshness !== "fresh") {
        rejected.push({ id: record.id, reason: `evidence is ${record.freshness}` });
        continue;
      }
      if (records.length < limit) records.push(record);
    }
    const matchingCount = this.all().filter((record) => (ids === undefined || ids.has(record.id)) && (kinds === undefined || kinds.has(record.kind))).length;
    return { records, omitted: Math.max(0, matchingCount - records.length), rejected };
  }

  createCapsule(options: {
    readonly sourceAgentId: string;
    readonly claims: readonly string[];
    readonly evidence?: EvidenceSelectOptions;
    readonly expiresAt?: string;
  }): EvidenceCapsule {
    const selection = this.select(options.evidence);
    const references = selection.records.map(({ id, kind, locator, digest }) => ({ id, kind, locator, digest }));
    const createdAt = this.#now();
    const digest = stableDigest({
      workspaceIdentityDigest: this.#workspaceIdentityDigest,
      references,
      claims: options.claims,
      sourceAgentId: options.sourceAgentId,
      createdAt,
    });
    return {
      capsuleId: `capsule-${digest}` as `capsule-${string}`,
      ...(this.#workspaceIdentityDigest !== undefined ? { workspaceIdentityDigest: this.#workspaceIdentityDigest } : {}),
      evidenceIds: references.map((reference) => reference.id as `evidence-${string}`),
      references,
      claims: options.claims.map((claim) => claim.slice(0, 2_000)),
      sourceAgentId: options.sourceAgentId,
      createdAt,
      ...(options.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
      digest,
    };
  }

  acceptCapsule(capsule: EvidenceCapsule, options: { readonly now?: string; readonly requireFresh?: boolean } = {}): EvidenceSelection {
    const expectedDigest = stableDigest({
      workspaceIdentityDigest: capsule.workspaceIdentityDigest,
      references: capsule.references,
      claims: capsule.claims,
      sourceAgentId: capsule.sourceAgentId,
      createdAt: capsule.createdAt,
    });
    if (capsule.digest !== expectedDigest) {
      return { records: [], omitted: capsule.evidenceIds.length, rejected: [{ id: capsule.capsuleId, reason: "capsule digest mismatch" }] };
    }
    const referenceIds = capsule.references.map((reference) => reference.id).sort();
    const evidenceIds = [...capsule.evidenceIds].sort();
    if (referenceIds.length !== evidenceIds.length || referenceIds.some((id, index) => id !== evidenceIds[index])) {
      return { records: [], omitted: capsule.evidenceIds.length, rejected: [{ id: capsule.capsuleId, reason: "capsule evidence references mismatch" }] };
    }
    if (capsule.expiresAt !== undefined && capsule.expiresAt <= (options.now ?? this.#now())) {
      return { records: [], omitted: capsule.evidenceIds.length, rejected: [{ id: capsule.capsuleId, reason: "capsule expired" }] };
    }
    if (this.#workspaceIdentityDigest !== undefined && capsule.workspaceIdentityDigest !== undefined && capsule.workspaceIdentityDigest !== this.#workspaceIdentityDigest) {
      return { records: [], omitted: capsule.evidenceIds.length, rejected: [{ id: capsule.capsuleId, reason: "capsule workspace identity mismatch" }] };
    }
    const digestMismatches: Array<{ id: string; reason: string }> = [];
    for (const reference of capsule.references) {
      const record = this.#records.get(reference.id as `evidence-${string}`);
      if (record === undefined) digestMismatches.push({ id: reference.id, reason: "evidence is missing" });
      else if (record.digest !== reference.digest) digestMismatches.push({ id: reference.id, reason: "evidence digest mismatch" });
    }
    if (digestMismatches.length > 0) return { records: [], omitted: capsule.evidenceIds.length, rejected: digestMismatches };
    return this.select({ ids: capsule.evidenceIds, requireFresh: options.requireFresh !== false });
  }

  /** Compact representation: references and digests only, never raw content. */
  compact(ids?: readonly `evidence-${string}`[]): readonly EvidenceReference[] {
    const selected = ids === undefined ? this.all() : ids.map((id) => this.#records.get(id)).filter((record): record is EvidenceRecord => record !== undefined);
    return selected.map(({ id, kind, locator, digest }) => ({ id, kind, locator, digest }));
  }

  private trim(): void {
    if (this.#records.size <= this.#maxRecords) return;
    const records = this.all();
    for (const record of records.slice(this.#maxRecords)) this.#records.delete(record.id);
  }

  private isIdentityCompatible(identityDigest: string | undefined): boolean {
    return this.#workspaceIdentityDigest === undefined || identityDigest === undefined || identityDigest === this.#workspaceIdentityDigest;
  }
}

function compareEvidence(left: EvidenceRecord, right: EvidenceRecord): number {
  return right.observedAt.localeCompare(left.observedAt) || left.id.localeCompare(right.id);
}

/** Canonical UTF-8 SHA-256 used by evidence, capsules, and exact IDs. */
export function evidenceDigest(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, (_key, current) => {
    if (current !== null && typeof current === "object" && !Array.isArray(current)) {
      return Object.fromEntries(
        Object.entries(current as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right)),
      );
    }
    return current;
  });
  return createHash("sha256").update(text).digest("hex");
}

const stableDigest = evidenceDigest;

