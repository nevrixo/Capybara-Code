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
  | "docs_only";

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
  const highRisk =
    changeSet.riskLevel === "high" ||
    changeSet.riskLevel === "critical" ||
    impact.includes("auth") ||
    impact.includes("config");
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
    (highRisk ||
      impact.includes("cross_module") ||
      impact.includes("dependency") ||
      impact.includes("config") ||
      impact.includes("generated"))
  ) {
    steps.push({
      id: "package-tests",
      tier: 2,
      required: highRisk,
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
  // Without a dependency graph the impacted packages are the best available
  // stand-in for their consumers; §5.21's graph input widens this.
  const consumers = impactedPackages;
  if (highRisk || impact.includes("cross_module") || impact.includes("dependency") || (changeSet.failedCommands?.length ?? 0) > 0 || (changeSet.reflectionPaths?.length ?? 0) > 0) {
    steps.push({
      id: "broader-tests",
      tier: 3,
      required: highRisk,
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
  if (highRisk) {
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