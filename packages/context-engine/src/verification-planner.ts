/**
 * Structured, impact-based verification planner.
 *
 * Commands are data until the host permission layer authorizes and executes them.
 * A missing required step is represented explicitly and must downgrade completion.
 */
export type VerificationTier = 0 | 1 | 2 | 3 | 4;

export interface VerificationCommand {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs: number;
}

export type VerificationImpactSignal =
  | "mutation"
  | "cross_module"
  | "config"
  | "auth"
  | "dependency"
  | "generated"
  | "test"
  | "docs_only"
  | "public_api"
  | "schema"
  | "signature_change"
  | "cosmetic";

/**
 * §5.21's semantic change type: what KIND of edit happened, not which file. A
 * signature change and a comment reflow have the same path and the same churn,
 * and verifying them identically is why a one-line docs edit could cost a full
 * run while a changed export went out on the edited file's own tests.
 */
export type SemanticChangeType =
  | "signature"
  | "behaviour"
  | "rename"
  | "cosmetic"
  | "addition"
  | "deletion";

/** Which of a change's public surfaces moved (§5.21 public API/schema/config). */
export interface PublicSurfaceChange {
  /** An exported symbol was added, removed, or re-signed. */
  readonly exportedSymbols?: boolean;
  /** A serialized schema, protocol event kind, or generated contract moved. */
  readonly schema?: boolean;
  /** A user-visible configuration key moved. */
  readonly config?: boolean;
}

/**
 * One workspace member as its manifest describes it (§5.21's dependency-graph
 * input). Parsing is the host's job — it owns the filesystem — but turning the
 * manifests into an impact set is a pure decision, so it lives here where the
 * plan can be tested without a repository.
 */
export interface WorkspacePackageManifest {
  /** Repository-relative directory, e.g. `packages/protocol-ts`. */
  readonly directory: string;
  /** Manifest name, e.g. `@cbc/protocol`. */
  readonly name: string;
  /** Workspace dependency names this member declares. */
  readonly dependencies: readonly string[];
}

/**
 * Reverse the declared dependencies into `directory -> every directory that
 * depends on it, transitively`.
 *
 * Transitive closure is the point. A change in `protocol-ts` reaches
 * `agent-kernel` only through `provider-openai`, so a one-hop map would verify
 * the direct importer and leave the actual consumer untested — the same blind
 * spot a path-prefix guess has.
 */
export function workspaceConsumerGraph(
  manifests: readonly WorkspacePackageManifest[],
): ReadonlyMap<string, readonly string[]> {
  const directoryByName = new Map<string, string>();
  for (const manifest of manifests) directoryByName.set(manifest.name, manifest.directory);

  const directConsumers = new Map<string, Set<string>>();
  for (const manifest of manifests) {
    for (const dependency of manifest.dependencies) {
      const dependencyDirectory = directoryByName.get(dependency);
      if (dependencyDirectory === undefined || dependencyDirectory === manifest.directory) continue;
      const consumers = directConsumers.get(dependencyDirectory) ?? new Set<string>();
      consumers.add(manifest.directory);
      directConsumers.set(dependencyDirectory, consumers);
    }
  }

  const graph = new Map<string, readonly string[]>();
  for (const manifest of manifests) {
    const reached = new Set<string>();
    const queue = [...(directConsumers.get(manifest.directory) ?? [])];
    while (queue.length > 0) {
      const next = queue.pop();
      if (next === undefined || reached.has(next) || next === manifest.directory) continue;
      reached.add(next);
      queue.push(...(directConsumers.get(next) ?? []));
    }
    graph.set(manifest.directory, Object.freeze([...reached].sort()));
  }
  return graph;
}

export interface VerificationChangeSet {
  readonly changedPaths: readonly string[];
  readonly addedPaths?: readonly string[];
  readonly deletedPaths?: readonly string[];
  readonly failedCommands?: readonly string[];
  /**
   * Paths a prior reflection blamed for a failure this turn (§5.21). A file the
   * agent already got wrong once is the last place a narrowed check should skip,
   * so naming it here widens the plan the same way a failed command does.
   */
  readonly reflectionPaths?: readonly string[];
  readonly riskLevel?: "low" | "medium" | "high" | "critical";
  readonly languageHints?: readonly ("typescript" | "rust" | "python" | "other")[];
  /**
   * §5.15: the verification width the route decision planned. It is a FLOOR, not
   * a replacement — impact may always widen past it, but a planned integration
   * check may not be narrowed away by a change that merely looks small, which is
   * the point of the router naming a level the contract is measured against.
   *
   * Declared as an open string so the planner does not depend on the provider
   * package; an unrecognized value imposes no floor.
   */
  readonly verificationLevel?: string;
  /**
   * §5.21 semantic change type. The host derives it from the diff it already
   * has; the plan only decides what it means. `cosmetic` is the one value that
   * narrows rather than widens, so it is trusted only when nothing else in the
   * change set argues against it.
   */
  readonly semanticChange?: SemanticChangeType;
  /** §5.21 public API / schema / config surfaces this change moved. */
  readonly publicSurface?: PublicSurfaceChange;
  /**
   * §5.21's dependency-graph input: `package directory -> its consumers`, from
   * `workspaceConsumerGraph`. Absent, the consumer tier can only fall back to the
   * changed packages themselves, which verifies nobody downstream.
   */
  readonly packageConsumers?: ReadonlyMap<string, readonly string[]>;
}

export interface VerificationStepPlan {
  readonly id: string;
  readonly tier: VerificationTier;
  readonly required: boolean;
  readonly command?: VerificationCommand;
  readonly covers: readonly string[];
  readonly escalate?: string;
  readonly reason: string;
}

export interface VerificationPlan {
  readonly version: "2";
  readonly impact: readonly VerificationImpactSignal[];
  readonly requiredCoverage: readonly string[];
  readonly steps: readonly VerificationStepPlan[];
  readonly partialIfMissing: boolean;
}

export function planVerification(changeSet: VerificationChangeSet): VerificationPlan {
  const paths = [...new Set(changeSet.changedPaths.map((path) => path.replaceAll("\\", "/")).filter(Boolean))];
  if (paths.length === 0) {
    return { version: "2", impact: [], requiredCoverage: [], steps: [], partialIfMissing: false };
  }
  const impact = impactSignals(changeSet, paths);
  // §5.21: a moved public surface is a consumer problem by definition — the
  // callers are what a changed export or schema breaks, and they are exactly
  // what the edited file's own tests cannot see.
  const reachesConsumers =
    impact.includes("public_api") || impact.includes("schema") || impact.includes("signature_change");
  const highRisk =
    changeSet.riskLevel === "high" ||
    changeSet.riskLevel === "critical" ||
    impact.includes("auth") ||
    impact.includes("config") ||
    reachesConsumers;
  // A cosmetic change is the only signal that narrows, so it is honoured only
  // when nothing else in the change set argues for widening. Trusting it over a
  // moved export or a prior failure would turn §5.21's cheapest input into a way
  // to skip verification.
  // §5.15: the route's planned width is a floor on the tiers the plan must reach.
  const level = changeSet.verificationLevel;
  const floorRequiresPackage =
    level === "package" || level === "integration" || level === "independent_review";
  const floorRequiresConsumers = level === "integration" || level === "independent_review";
  const floorRequiresReview = level === "independent_review";
  const cosmeticOnly =
    impact.includes("cosmetic") &&
    !highRisk &&
    !reachesConsumers &&
    !floorRequiresPackage &&
    (changeSet.failedCommands?.length ?? 0) === 0 &&
    (changeSet.reflectionPaths?.length ?? 0) === 0;
  const languages = new Set(changeSet.languageHints ?? paths.map(languageForPath));
  const steps: VerificationStepPlan[] = [
    {
      id: "revision-match",
      tier: 0,
      required: true,
      covers: ["revision_match"],
      reason: "each mutated file revision must match the recorded mutation result before anything is trusted",
    },
    {
      id: "parse-sanity",
      tier: 0,
      required: true,
      covers: ["parse"],
      reason: "changed source must remain syntactically valid",
    },
  ];
  const focusedCommand = focusedCommandFor(paths, languages);
  if (focusedCommand !== undefined) {
    steps.push({
      id: "focused-tests",
      tier: 1,
      required: true,
      command: focusedCommand,
      covers: ["focused_tests"],
      reason: "run the narrowest tests covering the changed language or test files",
    });
  }
  // §5.22 step 3: the changed packages' own suites, distinct from the focused
  // file-level run above. A package command scoped to the impacted packages is
  // what keeps a one-file edit from reaching for the whole matrix (§5.24's
  // "저위험 수정에서 불필요한 전체 테스트 실행 감소").
  const impactedPackages = impactedPackagesFor(paths);
  const packageCommand = packageCommandFor(impactedPackages, languages);
  if (
    packageCommand !== undefined &&
    !cosmeticOnly &&
    (floorRequiresPackage ||
      highRisk ||
      impact.includes("cross_module") ||
      impact.includes("dependency") ||
      impact.includes("config") ||
      impact.includes("generated"))
  ) {
    steps.push({
      id: "package-tests",
      tier: 2,
      required: highRisk || floorRequiresPackage,
      command: packageCommand,
      covers: ["package_tests"],
      escalate: "the change reaches past the edited files into their own packages",
      reason: "run the changed packages' own suites, not just the edited files'",
    });
  }
  // §5.22 step 4: the affected consumers. Scoped to the packages that depend on
  // the changed ones when a dependency graph is supplied, and to the impacted
  // packages themselves otherwise — never to the whole suite by default, which is
  // what made this tier indistinguishable from a full run.
  const consumers = consumersOf(impactedPackages, changeSet.packageConsumers);
  if (
    !cosmeticOnly &&
    (floorRequiresConsumers ||
      highRisk ||
      impact.includes("cross_module") ||
      impact.includes("dependency") ||
      (changeSet.failedCommands?.length ?? 0) > 0 ||
      (changeSet.reflectionPaths?.length ?? 0) > 0)
  ) {
    steps.push({
      id: "broader-tests",
      tier: 3,
      required: highRisk || floorRequiresConsumers,
      command: consumerCommandFor(consumers, languages),
      covers: ["broader_tests", ...(consumers.length > 0 ? ["affected_consumers"] : [])],
      escalate: "impact or prior failure justifies widening beyond focused tests",
      reason: consumers.length > 0
        ? `the change can affect consumers outside the edited files (${consumers.join(", ")})`
        : "the change can affect consumers outside the edited files",
    });
  }
  steps.push({
    id: "diff-integrity",
    tier: 3,
    required: true,
    command: { program: "git", args: ["diff", "--check"], timeoutMs: 30_000 },
    covers: ["diff_integrity", "authoritative_change_set"],
    reason: "confirm the final diff is bounded and free of whitespace corruption",
  });
  steps.push({
    id: "evidence-freshness",
    tier: 3,
    required: true,
    covers: ["evidence_freshness"],
    reason: "re-check that every captured verification result still matches the final workspace state",
  });
  if (highRisk || floorRequiresReview) {
    steps.push({
      id: "independent-review",
      tier: 4,
      required: true,
      covers: ["independent_review"],
      escalate: "high-impact changes require an independent reviewer",
      reason: "risk policy requires a separate review signal",
    });
  }
  steps.push({
    id: "todo-consistency",
    tier: 4,
    required: true,
    covers: ["todo_consistency"],
    reason: "the remaining TODO state must agree with the completion report before the turn can close",
  });
  const requiredCoverage = steps.filter((step) => step.required).flatMap((step) => step.covers);
  return {
    version: "2",
    impact: Object.freeze(impact),
    requiredCoverage: Object.freeze([...new Set(requiredCoverage)]),
    steps: Object.freeze(steps),
    partialIfMissing: true,
  };
}

export function verificationCommandDisplay(command: VerificationCommand): string {
  return [command.program, ...command.args].join(" ");
}

export function toLegacyVerificationCommand(
  plan: VerificationPlan,
): { command: string; reason: string } | undefined {
  // Prefer the narrowest executable step, but retain a broader impact-aware
  // command for config, dependency, and high-risk plans that have no focused
  // test mapping. Returning that fallback keeps the legacy kernel adapter from
  // silently converting a required verification into `not_run`.
  const step = plan.steps.find((candidate) => candidate.command !== undefined && candidate.tier <= 1) ??
    plan.steps.find((candidate) => candidate.command !== undefined && candidate.tier <= 2);
  return step?.command === undefined
    ? undefined
    : { command: verificationCommandDisplay(step.command), reason: step.reason };
}

export interface TurnVerificationCheck {
  readonly id: string;
  readonly command?: string;
  readonly tool?: string;
  readonly scope: readonly string[];
  readonly required: boolean;
}

export interface TurnVerificationContract {
  readonly workspaceGeneration: number;
  readonly changedPaths: readonly string[];
  readonly impactedPackages: readonly string[];
  readonly requiredChecks: readonly TurnVerificationCheck[];
  readonly reviewRequired: boolean;
  readonly evidenceRequirements: readonly string[];
}

export interface TurnVerificationContractInput {
  readonly changedPaths: readonly string[];
  readonly workspaceGeneration: number;
  readonly riskLevel?: VerificationChangeSet["riskLevel"];
  readonly reviewRequired?: boolean;
  readonly failedCommands?: readonly string[];
  /** Paths a prior reflection blamed this turn (§5.21). */
  readonly reflectionPaths?: readonly string[];
  readonly languageHints?: VerificationChangeSet["languageHints"];
  /** §5.21 dependency graph, from `workspaceConsumerGraph`. */
  readonly packageConsumers?: VerificationChangeSet["packageConsumers"];
  /** §5.21 semantic change type. */
  readonly semanticChange?: VerificationChangeSet["semanticChange"];
  /** §5.21 public API / schema / config surfaces this change moved. */
  readonly publicSurface?: VerificationChangeSet["publicSurface"];
  /** §5.15: the verification width the route planned, as a floor on the tiers. */
  readonly verificationLevel?: VerificationChangeSet["verificationLevel"];
}

// Every mutation turn owns one contract that names the checks the turn must
// clear before it may close. The contract is derived from the same plan the
// runtime dispatches so the required checks can never drift from the steps.
export function buildTurnVerificationContract(
  input: TurnVerificationContractInput,
): TurnVerificationContract {
  const changedPaths = [
    ...new Set(input.changedPaths.map((path) => path.replaceAll("\\", "/")).filter(Boolean)),
  ];
  const plan = planVerification({
    changedPaths,
    ...(input.riskLevel === undefined ? {} : { riskLevel: input.riskLevel }),
    ...(input.failedCommands === undefined ? {} : { failedCommands: input.failedCommands }),
    ...(input.languageHints === undefined ? {} : { languageHints: input.languageHints }),
    ...(input.packageConsumers === undefined ? {} : { packageConsumers: input.packageConsumers }),
    ...(input.semanticChange === undefined ? {} : { semanticChange: input.semanticChange }),
    ...(input.publicSurface === undefined ? {} : { publicSurface: input.publicSurface }),
    ...(input.verificationLevel === undefined ? {} : { verificationLevel: input.verificationLevel }),
    // The kernel supplies these, and dropping them here made the widening they
    // exist to trigger dead on the contract path.
    ...(input.reflectionPaths === undefined ? {} : { reflectionPaths: input.reflectionPaths }),
  });
  const impactedPackages = impactedPackagesFor(changedPaths);
  const requiredChecks = plan.steps
    .filter((step) => step.required)
    .map((step) => ({
      id: step.id,
      ...(step.command === undefined ? {} : { command: verificationCommandDisplay(step.command) }),
      scope: Object.freeze(step.tier <= 1 && changedPaths.length > 0 ? [...changedPaths] : [...impactedPackages]),
      required: true,
    }));
  const reviewRequired = input.reviewRequired ??
    plan.steps.some((step) => step.id === "independent-review");
  return {
    workspaceGeneration: input.workspaceGeneration,
    changedPaths: Object.freeze(changedPaths),
    impactedPackages: Object.freeze(impactedPackages),
    requiredChecks: Object.freeze(requiredChecks),
    reviewRequired,
    evidenceRequirements: Object.freeze([...plan.requiredCoverage]),
  };
}

/**
 * A required check that no verification record accounts for. §5.20 only makes
 * the contract worth building if an unmet required check can stop the turn, so
 * the settlement is a pure function of the contract plus the ids the runtime
 * actually satisfied — a host cannot claim coverage it did not record.
 */
export interface TurnVerificationSettlement {
  readonly satisfied: readonly string[];
  readonly unmet: readonly TurnVerificationCheck[];
  readonly complete: boolean;
}

export function settleTurnVerificationContract(
  contract: TurnVerificationContract,
  satisfiedIds: Iterable<string>,
): TurnVerificationSettlement {
  const satisfied = new Set<string>();
  for (const id of satisfiedIds) {
    const normalized = id.trim();
    if (normalized.length > 0) satisfied.add(normalized);
  }
  const unmet = contract.requiredChecks.filter(
    (check) => check.required && !satisfied.has(check.id),
  );
  return {
    satisfied: Object.freeze([...satisfied].sort()),
    unmet: Object.freeze(unmet),
    complete: unmet.length === 0,
  };
}

/**
 * Name the specific checks that are missing. A gate that only reported a count
 * left the operator guessing which stage of §5.22 never ran.
 */
export function describeUnmetRequiredChecks(
  unmet: readonly TurnVerificationCheck[],
): string {
  return unmet
    .map((check) => (check.command === undefined ? check.id : `${check.id} (${check.command})`))
    .join(", ");
}

/**
 * §5.21: widen the changed packages by the packages that depend on them. Without
 * a graph the impacted packages are the only honest stand-in — a path-prefix
 * guess cannot know that `agent-kernel` consumes `protocol-ts`.
 */
function consumersOf(
  impactedPackages: readonly string[],
  graph: ReadonlyMap<string, readonly string[]> | undefined,
): string[] {
  if (graph === undefined) return [...impactedPackages];
  const scope = new Set<string>(impactedPackages);
  for (const changed of impactedPackages) {
    for (const consumer of graph.get(changed) ?? []) scope.add(consumer);
  }
  return [...scope].sort();
}

function impactedPackagesFor(paths: readonly string[]): string[] {
  const packages = new Set<string>();
  for (const path of paths) {
    const segments = path.split("/");
    const root = segments[0];
    if (root === undefined) continue;
    if ((root === "packages" || root === "apps" || root === "crates") && segments[1] !== undefined) {
      packages.add(`${root}/${segments[1]}`);
      continue;
    }
    packages.add(segments.length > 1 ? root : ".");
  }
  return [...packages].sort();
}

function focusedCommandFor(
  paths: readonly string[],
  languages: ReadonlySet<string>,
): VerificationCommand | undefined {
  const tests = paths.filter((path) => /(?:^|[/.])(?:test|tests|__tests__)(?:[/.]|$)|\.(?:test|spec)\.[^.]+$/i.test(path));
  if (languages.has("rust")) {
    return { program: "cargo", args: ["test", "--workspace"], timeoutMs: 120_000 };
  }
  if (languages.has("typescript") || languages.has("python") || tests.length > 0) {
    return {
      program: languages.has("python") ? "python" : "bun",
      args: languages.has("python") ? ["-m", "pytest", ...tests] : ["test", ...tests],
      timeoutMs: 120_000,
    };
  }
  return undefined;
}

/**
 * A suite scoped to whole packages. `bun test <dir>` and `cargo test -p <name>`
 * both narrow to the given set, so a change confined to one package no longer
 * costs a full-matrix run. An empty scope has no narrower form than the suite.
 */
function scopedSuiteFor(
  scope: readonly string[],
  languages: ReadonlySet<string>,
  timeoutMs: number,
): VerificationCommand {
  if (languages.has("rust")) {
    const crates = scope.filter((entry) => entry.startsWith("crates/")).map((entry) => entry.slice("crates/".length));
    return crates.length > 0
      ? { program: "cargo", args: ["test", ...crates.flatMap((crate) => ["-p", crate])], timeoutMs }
      : { program: "cargo", args: ["test", "--workspace"], timeoutMs };
  }
  if (languages.has("python")) {
    return { program: "python", args: ["-m", "pytest", ...scope], timeoutMs };
  }
  const directories = scope.filter((entry) => entry !== ".");
  return { program: "bun", args: ["test", ...directories], timeoutMs };
}

function packageCommandFor(
  impactedPackages: readonly string[],
  languages: ReadonlySet<string>,
): VerificationCommand | undefined {
  if (impactedPackages.length === 0) return undefined;
  return scopedSuiteFor(impactedPackages, languages, 180_000);
}

function consumerCommandFor(
  consumers: readonly string[],
  languages: ReadonlySet<string>,
): VerificationCommand {
  return scopedSuiteFor(consumers, languages, 180_000);
}

function impactSignals(
  changeSet: VerificationChangeSet,
  paths: readonly string[],
): VerificationImpactSignal[] {
  const signals = new Set<VerificationImpactSignal>(["mutation"]);
  // §5.21: the semantic change type and the moved public surfaces are host
  // observations of the diff. Path regexes below can only guess at these — a
  // removed export in an ordinary .ts file matches nothing — so an explicit
  // signal always stands, and the regexes remain the fallback for a host that
  // supplies none.
  if (changeSet.publicSurface?.exportedSymbols === true) signals.add("public_api");
  if (changeSet.publicSurface?.schema === true) signals.add("schema");
  if (changeSet.publicSurface?.config === true) signals.add("config");
  if (changeSet.semanticChange === "signature") signals.add("signature_change");
  if (changeSet.semanticChange === "cosmetic") signals.add("cosmetic");
  if (paths.some((path) => /\.(?:json|ya?ml|toml|env|config)$/i.test(path))) signals.add("config");
  if (paths.some((path) => /(?:auth|permission|credential|security|policy)/i.test(path))) signals.add("auth");
  // The dependency signal belongs to manifests and lockfiles, so it is matched
  // against the file name. Testing the whole path made every file in a
  // `packages/` monorepo a dependency change, which pulled the package and
  // consumer tiers into every single-file edit — the opposite of §5.24's
  // "저위험 수정에서 불필요한 전체 테스트 실행 감소".
  if (paths.some((path) => /(?:^|\/)(?:package\.json|[^/]*lock[^/]*|cargo\.toml|go\.mod|requirements[^/]*)$/i.test(path))) {
    signals.add("dependency");
  }
  if (paths.some((path) => /(?:generated|schema|protocol)/i.test(path))) signals.add("generated");
  if (paths.some((path) => /(?:test|spec)\./i.test(path))) signals.add("test");
  if (paths.length > 1 && new Set(paths.map((path) => path.split("/")[0])).size > 1) signals.add("cross_module");
  if (paths.every((path) => /\.(?:md|txt|adoc)$/i.test(path))) {
    signals.delete("mutation");
    signals.add("docs_only");
  }
  return [...signals];
}

function languageForPath(path: string): "typescript" | "rust" | "python" | "other" {
  if (/\.(?:ts|tsx|js|jsx|mjs|cjs)$/i.test(path)) return "typescript";
  if (/\.rs$/i.test(path)) return "rust";
  if (/\.py$/i.test(path)) return "python";
  return "other";
}