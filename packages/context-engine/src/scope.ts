import type { ContextEngine } from "./engine.ts";
import {
  evidenceDigest,
  type EvidenceKind,
  type EvidenceProvenanceObservation,
  type EvidenceRecord,
} from "./evidence.ts";
import {
  type ScopedExactExcerpt,
  type TaskContextCapsule,
  pathAllowedByCapsule,
} from "./context-ops.ts";
import { isSensitivePath } from "./selection.ts";

/** Read-only baseline shared by scopes. Mutable evidence never lives here. */
export interface ContextBaseline {
  readonly workspaceIdentityDigest?: string;
  readonly workspaceGeneration: number;
  readonly instructionsDigest?: string;
  readonly skillsDigest?: string;
  readonly repositoryOrientationDigest?: string;
}

export type ContextScopeLifecycle = "active" | "terminal" | "disposed";

export interface AgentContextScope {
  readonly scopeId: string;
  readonly agentId: string;
  readonly parentScopeId: string | undefined;
  readonly taskId: string | undefined;
  readonly seedCapsuleDigest: string | undefined;
  readonly createdGeneration: number;
  readonly baseline: ContextBaseline | undefined;
  readonly engine: ContextEngine;
  readonly lifecycle: ContextScopeLifecycle;
  readonly consumedHandoffIds: readonly string[];
  markTerminal(): void;
  markHandoffConsumed(handoffId: string): boolean;
  dispose(): void;
}

export interface ContextScopeOptions {
  readonly scopeId: string;
  readonly agentId: string;
  readonly parentScopeId?: string;
  readonly taskId?: string;
  readonly seedCapsuleDigest?: string;
  readonly createdGeneration: number;
  readonly baseline?: ContextBaseline;
  readonly engine: ContextEngine;
}

class ContextScopeImpl implements AgentContextScope {
  readonly scopeId: string;
  readonly agentId: string;
  readonly parentScopeId: string | undefined;
  readonly taskId: string | undefined;
  readonly seedCapsuleDigest: string | undefined;
  readonly createdGeneration: number;
  readonly baseline: ContextBaseline | undefined;
  readonly engine: ContextEngine;
  #lifecycle: ContextScopeLifecycle = "active";
  readonly #consumed = new Set<string>();

  constructor(options: ContextScopeOptions) {
    this.scopeId = options.scopeId;
    this.agentId = options.agentId;
    this.parentScopeId = options.parentScopeId;
    this.taskId = options.taskId;
    this.seedCapsuleDigest = options.seedCapsuleDigest;
    this.createdGeneration = options.createdGeneration;
    this.baseline = options.baseline === undefined ? undefined : Object.freeze({ ...options.baseline });
    this.engine = options.engine;
  }

  get lifecycle(): ContextScopeLifecycle {
    return this.#lifecycle;
  }

  get consumedHandoffIds(): readonly string[] {
    return [...this.#consumed].sort();
  }

  markTerminal(): void {
    if (this.#lifecycle === "active") this.#lifecycle = "terminal";
  }

  markHandoffConsumed(handoffId: string): boolean {
    if (this.#consumed.has(handoffId)) return false;
    this.#consumed.add(handoffId);
    return true;
  }

  dispose(): void {
    if (this.#lifecycle === "disposed") return;
    this.#lifecycle = "disposed";
    this.engine.dispose();
  }
}

export function createContextScope(options: ContextScopeOptions): AgentContextScope {
  return new ContextScopeImpl(options);
}

export interface ForkContextFromCapsuleOptions extends ContextScopeOptions {
  readonly capsule: TaskContextCapsule;
}

/**
 * Seed a child scope with descriptor-only evidence and bounded exact bodies from
 * an immutable task capsule. The resulting ledger is private to the child.
 */
export function forkContextFromCapsule(
  options: ForkContextFromCapsuleOptions,
): AgentContextScope {
  const scope = createContextScope({
    ...options,
    seedCapsuleDigest: options.capsule.digest,
  });
  seedScopeFromCapsule(scope, options.capsule);
  return scope;
}

export function seedScopeFromCapsule(
  scope: AgentContextScope,
  capsule: TaskContextCapsule,
): void {
  const refs = new Map(capsule.evidenceRefs.map((reference) => [reference.id, reference]));
  const capsuleAgent = `capsule:${capsule.taskId}`;
  for (const reference of capsule.evidenceRefs) {
    const id = reference.id as `evidence-${string}`;
    scope.engine.recordEvidence({
      id,
      kind: "external_provenance",
      locator: reference.locator ?? reference.id,
      digest: reference.digest,
      observedAt: reference.observedAt ?? capsule.createdAt,
      summary: `seeded evidence ${reference.id}`,
      provenance: {
        agentId: capsuleAgent,
        taskId: capsule.taskId,
        callId: `capsule:${capsule.capsuleId}`,
        observedAt: reference.observedAt ?? capsule.createdAt,
        cacheHit: false,
        source: "capsule",
      },
      metadata: { capsuleId: capsule.capsuleId, source: "capsule" },
    });
  }

  for (const excerpt of capsule.scopedExactExcerpts ?? []) {
    if (
      isSensitivePath(excerpt.path) ||
      !pathAllowedByCapsule(capsule, excerpt.path) ||
      scopedExcerptDigest(excerpt) !== excerpt.bodyDigest
    ) continue;
    const added = scope.engine.addExcerpt({
      path: excerpt.path,
      text: excerpt.body,
      checksum: excerpt.checksum,
      totalLines: Math.max(excerpt.endLine, excerpt.startLine),
      startLine: excerpt.startLine,
    }, {
      relevanceScore: 100,
      leaseForNextCompiledPack: true,
      leaseOwner: scope.agentId,
    });
    if (!added) continue;
    const descriptor = scope.engine.exactExcerptDescriptor(excerpt.excerptId);
    const reference = refs.get(excerpt.evidenceId);
    if (descriptor === undefined || reference === undefined) continue;
    const record = scope.engine.recordEvidence({
      id: reference.id as `evidence-${string}`,
      kind: "file_excerpt",
      locator: reference.locator ?? `${excerpt.path}#L${excerpt.startLine}-${excerpt.endLine}`,
      digest: reference.digest,
      observedAt: reference.observedAt ?? capsule.createdAt,
      summary: `${excerpt.path}:${excerpt.startLine}-${excerpt.endLine}`,
      provenance: {
        agentId: capsuleAgent,
        taskId: capsule.taskId,
        callId: `capsule:${capsule.capsuleId}`,
        observedAt: reference.observedAt ?? capsule.createdAt,
        cacheHit: false,
        source: "capsule",
      },
      metadata: {
        capsuleId: capsule.capsuleId,
        path: excerpt.path,
        runtimeChecksum: excerpt.checksum,
        excerptId: descriptor.id,
        source: "capsule",
      },
    });
    scope.engine.bindExcerptEvidence(descriptor.id, record);
  }
}

export interface HandoffEvidenceRef {
  readonly id: string;
  readonly kind: EvidenceKind;
  readonly locator: string;
  readonly digest: string;
  readonly freshness: "fresh" | "stale" | "invalid" | "unknown";
  readonly path?: string;
  readonly checksum?: string;
}

export interface HandoffExactExcerpt {
  readonly excerptId: string;
  readonly evidenceId: string;
  readonly path: string;
  readonly checksum: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly bodyDigest: string;
  readonly body?: string;
}

export interface ChildContextHandoff {
  readonly version: 1;
  readonly handoffId: string;
  readonly taskId: string;
  readonly sourceAgentId: string;
  readonly sourceScopeId: string;
  readonly parentScopeId: string;
  readonly seedCapsuleDigest: string;
  readonly workspaceIdentityDigest?: string;
  readonly baseGeneration: number;
  readonly completionGeneration: number;
  readonly status: "completed" | "blocked" | "failed" | "cancelled";
  readonly claims: readonly string[];
  readonly evidence: readonly HandoffEvidenceRef[];
  readonly exactExcerpts?: readonly HandoffExactExcerpt[];
  readonly artifactRefs: readonly string[];
  readonly changedPaths: readonly string[];
  readonly createdAt: string;
  readonly digest: string;
}

export interface ExportContextHandoffOptions {
  readonly taskId: string;
  readonly parentScopeId: string;
  readonly seedCapsuleDigest: string;
  readonly baseGeneration: number;
  readonly completionGeneration: number;
  readonly status: ChildContextHandoff["status"];
  readonly claims?: readonly string[];
  readonly artifactRefs?: readonly string[];
  readonly changedPaths?: readonly string[];
  readonly workspaceIdentityDigest?: string;
  readonly now?: string;
  readonly allowedPaths?: readonly string[];
  readonly forbiddenPaths?: readonly string[];
  readonly maxEvidence?: number;
  readonly maxExactExcerptTokens?: number;
}

export function exportContextHandoff(
  scope: AgentContextScope,
  options: ExportContextHandoffOptions,
): ChildContextHandoff {
  const selected = scope.engine.selectEvidence({
    limit: Math.max(1, Math.floor(options.maxEvidence ?? 64)),
    requireFresh: false,
  });
  const evidence: HandoffEvidenceRef[] = [];
  const exactExcerpts: HandoffExactExcerpt[] = [];
  let exactTokens = 0;
  for (const record of selected.records) {
    // Capsule seed records are parent input, not child-produced findings. Do not
    // echo them back through a handoff or turn a no-op child into root churn.
    if (record.metadata?.source === "capsule") continue;
    const path = evidencePath(record);
    if (path !== undefined && (
      isSensitivePath(path) ||
      !pathWithinAny(path, options.allowedPaths ?? ["."], options.forbiddenPaths ?? [])
    )) continue;
    const descriptorId = typeof record.metadata?.excerptId === "string" ? record.metadata.excerptId : undefined;
    const descriptor = descriptorId === undefined ? undefined : scope.engine.exactExcerptDescriptor(descriptorId);
    evidence.push({
      id: record.id,
      kind: record.kind,
      locator: record.locator,
      digest: record.digest,
      freshness: record.freshness,
      ...(path === undefined ? {} : { path }),
      ...(descriptor === undefined ? {} : { checksum: descriptor.checksum }),
    });
    if (
      descriptor !== undefined &&
      record.freshness === "fresh" &&
      options.status === "completed" &&
      !isSensitivePath(descriptor.path) &&
      pathWithinAny(descriptor.path, options.allowedPaths ?? ["."], options.forbiddenPaths ?? [])
    ) {
      const bodyTokens = Math.max(1, Math.ceil(descriptor.text.length / 4));
      if (exactTokens + bodyTokens <= Math.max(0, Math.floor(options.maxExactExcerptTokens ?? 12_000))) {
        exactExcerpts.push({
          excerptId: descriptor.id,
          evidenceId: record.id,
          path: descriptor.path,
          checksum: descriptor.checksum,
          startLine: descriptor.startLine,
          endLine: descriptor.endLine,
          bodyDigest: evidenceDigest(descriptor.text),
          body: descriptor.text,
        });
        exactTokens += bodyTokens;
      }
    }
  }
  const createdAt = options.now ?? new Date().toISOString();
  const handoffId = `context-handoff-${evidenceDigest({
    taskId: options.taskId,
    sourceScopeId: scope.scopeId,
    createdAt,
    evidence: evidence.map(({ id, digest }) => ({ id, digest })),
  })}`;
  const payload = {
    version: 1 as const,
    handoffId,
    taskId: options.taskId,
    sourceAgentId: scope.agentId,
    sourceScopeId: scope.scopeId,
    parentScopeId: options.parentScopeId,
    seedCapsuleDigest: options.seedCapsuleDigest,
    ...(options.workspaceIdentityDigest === undefined ? {} : { workspaceIdentityDigest: options.workspaceIdentityDigest }),
    baseGeneration: options.baseGeneration,
    completionGeneration: options.completionGeneration,
    status: options.status,
    claims: (options.claims ?? []).map((claim) => claim.slice(0, 2_000)).slice(0, 32),
    evidence,
    ...(exactExcerpts.length > 0 ? { exactExcerpts } : {}),
    artifactRefs: [...new Set(options.artifactRefs ?? [])].slice(0, 64),
    changedPaths: [...new Set(options.changedPaths ?? [])].slice(0, 128),
    createdAt,
  };
  return Object.freeze({ ...payload, digest: evidenceDigest(payload) });
}

export interface HandoffValidationContext {
  readonly parentScopeId: string;
  readonly expectedTaskId?: string;
  readonly expectedSourceAgentId?: string;
  readonly expectedSeedCapsuleDigest?: string;
  readonly workspaceIdentityDigest?: string;
  readonly currentGeneration?: number;
  readonly allowedPaths?: readonly string[];
  readonly forbiddenPaths?: readonly string[];
  readonly allowStaleGeneration?: boolean;
}

export interface ContextHandoffValidation {
  readonly valid: boolean;
  readonly issues: readonly string[];
  readonly stale: boolean;
}

export function validateContextHandoff(
  handoff: ChildContextHandoff,
  context: HandoffValidationContext,
): ContextHandoffValidation {
  const issues: string[] = [];
  const { digest: _digest, ...payload } = handoff;
  if (handoff.version !== 1) issues.push("unsupported context handoff version");
  if (handoff.digest !== evidenceDigest(payload)) issues.push("context handoff digest mismatch");
  if (handoff.parentScopeId !== context.parentScopeId) issues.push("context handoff parent scope mismatch");
  if (context.expectedTaskId !== undefined && handoff.taskId !== context.expectedTaskId) issues.push("context handoff task mismatch");
  if (context.expectedSourceAgentId !== undefined && handoff.sourceAgentId !== context.expectedSourceAgentId) issues.push("context handoff source agent mismatch");
  if (context.expectedSeedCapsuleDigest !== undefined && handoff.seedCapsuleDigest !== context.expectedSeedCapsuleDigest) issues.push("context handoff seed capsule mismatch");
  if (context.workspaceIdentityDigest !== undefined && handoff.workspaceIdentityDigest !== context.workspaceIdentityDigest) issues.push("context handoff workspace identity mismatch");
  if (handoff.completionGeneration < handoff.baseGeneration) issues.push("context handoff completion generation precedes its base generation");
  if (handoff.status !== "completed" && (handoff.exactExcerpts?.length ?? 0) > 0) issues.push("non-completed context handoff cannot carry exact excerpts");
  const stale = context.currentGeneration !== undefined && handoff.completionGeneration < context.currentGeneration;
  if (stale && context.allowStaleGeneration !== true) issues.push("context handoff generation is stale");
  for (const reference of handoff.evidence) {
    if (reference.path !== undefined && (
      isSensitivePath(reference.path) ||
      !pathWithinAny(reference.path, context.allowedPaths ?? ["."], context.forbiddenPaths ?? [])
    )) issues.push(`context handoff evidence path is outside authority: ${reference.path}`);
  }
  const evidenceById = new Map(handoff.evidence.map((reference) => [reference.id, reference]));
  for (const excerpt of handoff.exactExcerpts ?? []) {
    if (evidenceById.get(excerpt.evidenceId)?.freshness !== "fresh") issues.push("context handoff exact excerpt references non-fresh evidence: " + excerpt.path);
    if (isSensitivePath(excerpt.path) || !pathWithinAny(excerpt.path, context.allowedPaths ?? ["."], context.forbiddenPaths ?? [])) issues.push(`context handoff excerpt path is outside authority: ${excerpt.path}`);
    if (excerpt.body !== undefined && evidenceDigest(excerpt.body) !== excerpt.bodyDigest) issues.push(`context handoff excerpt body digest mismatch: ${excerpt.path}`);
    if (stale && context.allowStaleGeneration !== true) issues.push(`context handoff exact excerpt is stale: ${excerpt.path}`);
  }
  return Object.freeze({ valid: issues.length === 0, issues: [...new Set(issues)].sort(), stale });
}

export interface ImportContextHandoffOptions extends HandoffValidationContext {
  readonly maxEvidence?: number;
  readonly maxExactExcerptTokens?: number;
}

export interface ContextHandoffImportResult {
  readonly accepted: boolean;
  readonly alreadyConsumed: boolean;
  readonly importedEvidenceIds: readonly string[];
  readonly importedExcerptIds: readonly string[];
  readonly rejected: readonly string[];
}

export function importContextHandoff(
  rootScope: AgentContextScope,
  handoff: ChildContextHandoff,
  options: ImportContextHandoffOptions,
): ContextHandoffImportResult {
  const validation = validateContextHandoff(handoff, options);
  if (!validation.valid) return {
    accepted: false,
    alreadyConsumed: false,
    importedEvidenceIds: [],
    importedExcerptIds: [],
    rejected: validation.issues,
  };
  const conflictingEvidence = handoff.evidence.find((reference) => {
    const existing = rootScope.engine.evidence.get(reference.id as import("./evidence.ts").EvidenceRecord["id"]);
    return existing !== undefined && existing.digest !== reference.digest;
  });
  if (conflictingEvidence !== undefined) return {
    accepted: false,
    alreadyConsumed: false,
    importedEvidenceIds: [],
    importedExcerptIds: [],
    rejected: ["context handoff evidence conflicts with existing root evidence: " + conflictingEvidence.id],
  };
  if (!rootScope.markHandoffConsumed(handoff.handoffId)) return {
    accepted: false,
    alreadyConsumed: true,
    importedEvidenceIds: [],
    importedExcerptIds: [],
    rejected: ["context handoff already consumed"],
  };

  const importedEvidenceIds: string[] = [];
  const importedExcerptIds: string[] = [];
  const exactByEvidence = new Map((handoff.exactExcerpts ?? []).map((excerpt) => [excerpt.evidenceId, excerpt]));
  let exactTokens = 0;
  for (const reference of handoff.evidence.slice(0, Math.max(1, Math.floor(options.maxEvidence ?? 64)))) {
    const existing = rootScope.engine.evidence.get(reference.id as `evidence-${string}`);
    const excerpt = exactByEvidence.get(reference.id);
    const provenance: EvidenceProvenanceObservation = {
      agentId: handoff.sourceAgentId,
      taskId: handoff.taskId,
      callId: handoff.handoffId,
      observedAt: handoff.createdAt,
      cacheHit: false,
      source: "handoff",
    };
    const record = rootScope.engine.recordEvidence({
      id: reference.id as `evidence-${string}`,
      kind: reference.kind,
      locator: reference.locator,
      digest: reference.digest,
      observedAt: handoff.createdAt,
      summary: `accepted evidence from ${handoff.sourceAgentId}`,
      provenance,
      metadata: {
        handoffId: handoff.handoffId,
        sourceAgentId: handoff.sourceAgentId,
        ...(reference.path === undefined ? {} : { path: reference.path }),
        ...(reference.checksum === undefined ? {} : { runtimeChecksum: reference.checksum }),
        source: "handoff",
      },
    });
    if (existing === undefined || existing.digest === record.digest) importedEvidenceIds.push(record.id);
    if (excerpt?.body === undefined) continue;
    const bodyTokens = Math.max(1, Math.ceil(excerpt.body.length / 4));
    if (exactTokens + bodyTokens > Math.max(0, Math.floor(options.maxExactExcerptTokens ?? 12_000))) continue;
    const added = rootScope.engine.addExcerpt({
      path: excerpt.path,
      text: excerpt.body,
      checksum: excerpt.checksum,
      totalLines: Math.max(excerpt.endLine, excerpt.startLine),
      startLine: excerpt.startLine,
    }, { relevanceScore: 100, leaseForNextCompiledPack: true, leaseOwner: "root" });
    if (!added) continue;
    const descriptor = rootScope.engine.exactExcerptDescriptor(excerpt.excerptId);
    if (descriptor === undefined) continue;
    rootScope.engine.bindExcerptEvidence(descriptor.id, record);
    importedExcerptIds.push(descriptor.id);
    exactTokens += bodyTokens;
  }
  return { accepted: true, alreadyConsumed: false, importedEvidenceIds, importedExcerptIds, rejected: [] };
}

export function contextScopeDigest(scope: AgentContextScope): string {
  return evidenceDigest({
    scopeId: scope.scopeId,
    agentId: scope.agentId,
    lifecycle: scope.lifecycle,
    baseline: scope.baseline,
    engine: scope.engine.contextDigest(),
    consumedHandoffIds: scope.consumedHandoffIds,
  });
}

function scopedExcerptDigest(excerpt: ScopedExactExcerpt): string {
  return evidenceDigest(excerpt.body);
}

function evidencePath(record: EvidenceRecord): string | undefined {
  const path = record.metadata?.path;
  return typeof path === "string" ? path.replaceAll("\\", "/").replace(/^\.\//, "") : undefined;
}

function pathWithinAny(path: string, allowed: readonly string[], forbidden: readonly string[]): boolean {
  const matches = (boundary: string): boolean => {
    const normalized = boundary.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/u, "") || ".";
    return normalized === "." || path === normalized || path.startsWith(`${normalized}/`);
  };
  return allowed.some(matches) && !forbidden.some(matches);
}
