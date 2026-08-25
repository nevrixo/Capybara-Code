/**
 * Command classification — PRD §13.5, Appendix C.
 *
 * §13.5 is emphatic on two points that shape this file:
 *   - "Regex만으로 allow하지 않는다" — a pattern match may *raise* risk but never
 *     lower it below the tool's declared baseline,
 *   - "classifier가 불확실하면 higher risk로 승격한다" — unknown means escalate.
 */

import type { RiskClass } from "@cbc/tool-registry";

/**
 * What a process invocation actually is.
 *
 * `process.run sh -c "…"` is not a direct executable invocation even though it
 * arrives through the same tool: the argument is an unparsed program. Treating
 * the three shapes alike is what let `shell = "deny"` be bypassed by running a
 * shell through `process.run` (P0-04).
 */
export type ProcessSemantics =
  | "direct-executable"
  | "shell-script"
  | "interpreter-inline-code";

export interface CommandSpec {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** True when the caller used `shell.run` rather than `process.run`. */
  readonly rawShell?: boolean;
  readonly env?: Readonly<Record<string, string>>;
  /** Detected invocation shape; defaults to `direct-executable`. */
  readonly semantics?: ProcessSemantics;
  /** The unparsed script or inline code, when the semantics are not direct. */
  readonly script?: string;
  /** The model's declared need for network (§24.1: intent, never a grant). */
  readonly networkIntent?: { readonly required: boolean; readonly reason?: string };
}

export interface Classification {
  readonly risk: RiskClass;
  /** Human-readable reasons, shown on the approval card (§7.6). */
  readonly reasons: string[];
  readonly network: boolean;
  readonly destructive: boolean;
  readonly privileged: boolean;
  readonly externalSideEffect: boolean;
  readonly touchesCredentials: boolean;
  /** True when the classifier could not recognize the program. */
  readonly unknownProgram: boolean;
  /** True when the invocation is a shell script or interpreter inline code. */
  readonly shellLike: boolean;
  readonly executesProjectCode: boolean;
  readonly readsOnly: boolean;
  readonly expectedWorkspaceWrites: boolean;
  readonly networkIntent: "none" | "possible" | "required";
  readonly executableIdentity: string;
  /** Predicted side effects, listed on the approval card. */
  readonly sideEffects: string[];
}

const RISK_ORDER: RiskClass[] = ["R0", "R1", "R2", "R3", "R4", "R5", "R6"];

export function maxRisk(a: RiskClass, b: RiskClass): RiskClass {
  return RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b;
}

/** Programs that are safe, local, and reversible: tests, builds, formatters. */
const SAFE_LOCAL_PROGRAMS = new Set([
  "cargo",
  "go",
  "rustc",
  "tsc",
  "bun",
  "node",
  "deno",
  "python",
  "python3",
  "pytest",
  "ruby",
  "rake",
  "java",
  "javac",
  "gradle",
  "mvn",
  "make",
  "cmake",
  "ninja",
  "jest",
  "vitest",
  "mocha",
  "eslint",
  "prettier",
  "ruff",
  "black",
  "mypy",
  "clippy",
  "gofmt",
  "rustfmt",
  "biome",
  "swift",
  "dotnet",
  "phpunit",
  "composer",
  "bundle",
  "tox",
  "nox",
]);

/** Privilege elevation. Always R4. */
const PRIVILEGE_PROGRAMS = new Set(["sudo", "doas", "su", "runas", "pkexec", "setcap", "chown"]);

/** Programs that reach the network by nature. */
const NETWORK_PROGRAMS = new Set([
  "curl",
  "wget",
  "ssh",
  "scp",
  "rsync",
  "nc",
  "netcat",
  "telnet",
  "ftp",
  "aws",
  "gcloud",
  "az",
  "kubectl",
  "helm",
  "terraform",
  "docker",
  "podman",
  "gh",
  "glab",
  "http",
  "httpie",
]);

/** Package managers: network plus dependency mutation plus lifecycle scripts. */
const PACKAGE_MANAGERS = new Set([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "pip",
  "pip3",
  "poetry",
  "uv",
  "gem",
  "cargo",
  "go",
  "composer",
  "brew",
  "apt",
  "apt-get",
  "yum",
  "dnf",
  "pacman",
  "apk",
  "nix",
]);

/** Subcommands of a package manager that install or publish. */
const INSTALL_SUBCOMMANDS = new Set([
  "install",
  "i",
  "add",
  "ci",
  "update",
  "upgrade",
  "sync",
  "get",
  "fetch",
  "restore",
]);

const PUBLISH_SUBCOMMANDS = new Set(["publish", "push", "release", "deploy", "upload"]);

/** Paths that indicate credential access (§13.2 R5). */
const CREDENTIAL_PATH_MARKERS = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker/config.json",
  ".npmrc",
  ".netrc",
  ".pypirc",
  "id_rsa",
  "id_ed25519",
  ".env",
  "credentials",
  "secrets",
];

/** Variables that can change what executable is loaded or what code it runs. */
const EXECUTABLE_CONTROL_ENV = /^(?:LD_|DYLD_|BASH_ENV$|ENV$|NODE_OPTIONS$|PYTHON(?:PATH|HOME|STARTUP|INSPECT)?$|RUBYOPT$|RUBYLIB$|PERL5OPT$|PERL5LIB$|GIT_(?:CONFIG|EXEC_PATH|TEMPLATE_DIR|SSH_COMMAND))/i;

const CREDENTIAL_ENV = /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL|AUTH)/i;

/** Shells invoked with a script argument run arbitrary code, not one program. */
const SHELL_INLINE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  sh: ["-c"],
  bash: ["-c"],
  zsh: ["-c"],
  ksh: ["-c"],
  dash: ["-c"],
  fish: ["-c"],
  cmd: ["/c", "/k", "-c"],
  "cmd.exe": ["/c", "/k", "-c"],
  powershell: ["-command", "-encodedcommand", "-c", "-e"],
  "powershell.exe": ["-command", "-encodedcommand"],
  pwsh: ["-command", "-encodedcommand", "-c", "-e"],
  "pwsh.exe": ["-command", "-encodedcommand"],
};

/** Interpreters invoked with inline code run arbitrary code, not one program. */
const INTERPRETER_INLINE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  node: ["-e", "--eval", "-p", "--print"],
  deno: ["eval"],
  bun: ["-e", "--eval"],
  python: ["-c"],
  python3: ["-c"],
  python2: ["-c"],
  ruby: ["-e"],
  perl: ["-e"],
  php: ["-r"],
  lua: ["-e"],
};

/**
 * Detect the invocation shape of a process call (P0-04).
 *
 * `sh -c`, `cmd /c`, `node --eval`, `python -c` and their siblings are not a
 * direct executable plus arguments: everything after the flag is one unparsed
 * program. Callers must never classify these through the safe-local fast path
 * or let a stored command-prefix rule cover them.
 */
export function detectProcessSemantics(spec: CommandSpec): ProcessSemantics {
  if (spec.semantics !== undefined) return spec.semantics;
  if (spec.rawShell === true) return "shell-script";
  const program = basename(spec.program);
  const first = (spec.args[0] ?? "").toLowerCase();
  if (SHELL_INLINE_FLAGS[program]?.includes(first)) return "shell-script";
  // `python -c` may carry the code in the next argument; `deno eval` is a
  // subcommand rather than a flag.
  if (INTERPRETER_INLINE_FLAGS[program]?.includes(first)) return "interpreter-inline-code";
  return "direct-executable";
}

/** Classify a command into a risk class with explicit reasons. */
export function classifyCommand(spec: CommandSpec, baseline: RiskClass = "R1"): Classification {
  const reasons: string[] = [];
  const sideEffects: string[] = [];
  let risk = baseline;
  let network = false;
  let destructive = false;
  let privileged = false;
  let externalSideEffect = false;
  let touchesCredentials = false;

  const program = basename(spec.program);
  const args = spec.args.map((a) => a);
  const joined = [program, ...args].join(" ");
  const unknownProgram = !isKnownProgram(program);
  const semantics = detectProcessSemantics(spec);
  const shellLike = semantics !== "direct-executable";
  const explicitEnv = Object.entries(spec.env ?? {});
  const readsOnly = explicitEnv.length === 0 && isFixedReadOnlyInvocation(program, args, semantics);
  const executesProjectCode =
    shellLike ||
    !readsOnly &&
      (SAFE_LOCAL_PROGRAMS.has(program) ||
        PACKAGE_MANAGERS.has(program) ||
        unknownProgram);
  const expectedWorkspaceWrites = executesProjectCode && !readsOnly;
  // For a shell script or inline code the *code string* is the command. Analyse
  // it where a direct invocation would analyse the argv.
  const inlineCode = spec.script ?? (shellLike ? args.slice(1).join(" ") : "");

  // An explicit environment is part of the executable operation, not harmless
  // metadata. It therefore never qualifies for safe-auto.
  if (explicitEnv.length > 0) {
    risk = maxRisk(risk, "R3");
    reasons.push("sets an explicit process environment");
    sideEffects.push("changes executable process semantics through environment variables");
    if (explicitEnv.some(([name]) => EXECUTABLE_CONTROL_ENV.test(name))) {
      risk = maxRisk(risk, "R4");
      reasons.push("sets an executable-loader or interpreter-control environment variable");
    }
    if (explicitEnv.some(([name]) => CREDENTIAL_ENV.test(name))) {
      touchesCredentials = true;
      risk = maxRisk(risk, "R5");
      reasons.push("sets a credential-shaped environment variable");
    }
  }

  // ---- Privilege elevation (R4) ----
  if (PRIVILEGE_PROGRAMS.has(program)) {
    privileged = true;
    risk = maxRisk(risk, "R4");
    reasons.push(`${program} elevates privileges`);
    sideEffects.push("runs with elevated privileges");
  }

  // ---- Destructive filesystem operations (R4) ----
  if (program === "rm") {
    destructive = true;
    const recursive = args.some((a) => /^-[a-z]*r/i.test(a) || a === "--recursive");
    const force = args.some((a) => /^-[a-z]*f/i.test(a) || a === "--force");
    risk = maxRisk(risk, recursive || force ? "R4" : "R3");
    reasons.push(recursive ? "recursive delete" : "file delete");
    sideEffects.push("deletes files");
    if (args.some((a) => a === "/" || a === "/*" || a === "~" || a === "~/")) {
      reasons.push("targets a filesystem or home root");
    }
  }
  for (const marker of ["mkfs", "dd", "fdisk", "diskutil", "shred", "srm"]) {
    if (program === marker) {
      destructive = true;
      risk = maxRisk(risk, "R4");
      reasons.push(`${program} can destroy data irrecoverably`);
      sideEffects.push("may destroy data irrecoverably");
    }
  }
  if (program === "chmod" || program === "chown" || program === "setfacl" || program === "icacls") {
    const broad = args.some((a) => a === "-R" || a === "--recursive" || a === "/" || a === "777");
    risk = maxRisk(risk, broad ? "R4" : "R2");
    reasons.push(broad ? "broad permission change" : "permission change");
    sideEffects.push("changes file permissions");
    if (broad) destructive = true;
  }

  // ---- Destructive Git (R4) ----
  if (program === "git") {
    const sub = args[0] ?? "";
    if (sub === "reset" && args.some((a) => a === "--hard")) {
      destructive = true;
      risk = maxRisk(risk, "R4");
      reasons.push("git reset --hard discards uncommitted work");
      sideEffects.push("discards uncommitted changes");
    }
    if (sub === "clean" && args.some((a) => /^-[a-z]*f/i.test(a))) {
      destructive = true;
      risk = maxRisk(risk, "R4");
      reasons.push("git clean -f removes untracked files");
      sideEffects.push("removes untracked files");
    }
    if (sub === "checkout" && args.includes("--force")) {
      destructive = true;
      risk = maxRisk(risk, "R4");
      reasons.push("forced checkout discards local changes");
    }
    if (sub === "push") {
      externalSideEffect = true;
      network = true;
      risk = maxRisk(risk, "R6");
      reasons.push("git push publishes to a remote");
      sideEffects.push("publishes commits to a remote");
      if (args.some((a) => a === "--force" || a === "-f" || a === "--force-with-lease")) {
        reasons.push("force push can overwrite remote history");
        destructive = true;
      }
    }
    if (sub === "commit") {
      // §12.2 withholds a commit tool; a raw commit still mutates local history.
      risk = maxRisk(risk, "R2");
      reasons.push("creates a commit");
      sideEffects.push("creates a commit");
    }
    if (["fetch", "pull", "clone", "remote", "ls-remote"].includes(sub)) {
      network = true;
      risk = maxRisk(risk, "R3");
      reasons.push(`git ${sub} contacts a remote`);
    }
    if (["status", "diff", "log", "show", "rev-parse", "ls-files", "branch"].includes(sub)) {
      // Read-only: leave the baseline alone.
      reasons.push(`git ${sub} is read-only`);
    }
  }

  // ---- Package managers ----
  if (PACKAGE_MANAGERS.has(program)) {
    const sub = args.find((a) => !a.startsWith("-")) ?? "";
    if (INSTALL_SUBCOMMANDS.has(sub)) {
      network = true;
      risk = maxRisk(risk, "R3");
      reasons.push(`${program} ${sub} downloads dependencies and may run lifecycle scripts`);
      sideEffects.push("modifies dependency files", "downloads packages", "may run lifecycle scripts");
    }
    if (PUBLISH_SUBCOMMANDS.has(sub)) {
      network = true;
      externalSideEffect = true;
      risk = maxRisk(risk, "R6");
      reasons.push(`${program} ${sub} publishes to an external registry`);
      sideEffects.push("publishes an artifact externally");
    }
  }

  // ---- Network programs ----
  if (NETWORK_PROGRAMS.has(program)) {
    network = true;
    risk = maxRisk(risk, "R3");
    reasons.push(`${program} uses the network`);
    // Upload flags plus a credential-shaped argument means exfiltration risk.
    const uploads = args.some((a) =>
      ["-d", "--data", "--data-binary", "-F", "--form", "-T", "--upload-file", "--data-raw"].includes(a),
    );
    if (uploads) {
      risk = maxRisk(risk, "R6");
      externalSideEffect = true;
      reasons.push(`${program} uploads data to a remote endpoint`);
      sideEffects.push("sends local data to a remote endpoint");
    }
  }
  if (["kubectl", "helm", "terraform", "aws", "gcloud", "az"].includes(program)) {
    const mutating = args.some((a) =>
      ["apply", "delete", "create", "destroy", "deploy", "upgrade", "rollout", "put", "write"].includes(a),
    );
    if (mutating) {
      externalSideEffect = true;
      risk = maxRisk(risk, "R6");
      reasons.push(`${program} mutates external infrastructure`);
      sideEffects.push("changes external infrastructure");
    }
  }

  // ---- Credential access (R5) ----
  const allText = `${joined} ${explicitEnv.map(([key, value]) => `${key}=${value}`).join(" ")}`.toLowerCase();
  for (const marker of CREDENTIAL_PATH_MARKERS) {
    if (allText.includes(marker)) {
      touchesCredentials = true;
      risk = maxRisk(risk, "R5");
      reasons.push(`references credential material (${marker})`);
      sideEffects.push("reads credential material");
      break;
    }
  }

  // ---- Raw shell and inline code (P0-04) ----
  // `shell.run`, `sh -c`, `cmd /c`, `node -e`, `python -c` and siblings execute
  // an unparsed program: it can chain, pipe, redirect, and reach the network
  // regardless of the program name that carries it.
  if (shellLike) {
    risk = maxRisk(risk, "R3");
    reasons.push(
      semantics === "interpreter-inline-code"
        ? `${program} runs inline code that can chain, pipe, and redirect`
        : "shell script can chain, pipe, and redirect",
    );
    const analysed = inlineCode.length > 0 ? inlineCode : joined;
    const analysedLower = analysed.toLowerCase();
    // Redirection outside the workspace is called out in §13.5.
    if (/>\s*(\/|~|\.\.\/)/.test(analysed)) {
      risk = maxRisk(risk, "R4");
      reasons.push("redirects output outside the workspace");
      sideEffects.push("writes outside the workspace");
    }
    if (/\|\s*(sh|bash|zsh|python3?)\b/.test(analysedLower)) {
      risk = maxRisk(risk, "R4");
      reasons.push("pipes downloaded content into an interpreter");
    }
    // A fork bomb pattern.
    if (/:\(\)\s*\{.*\|.*&.*\}\s*;\s*:/.test(analysed)) {
      risk = maxRisk(risk, "R4");
      destructive = true;
      reasons.push("matches a fork bomb pattern");
    }
    // Inline code that names a network primitive is network use, whatever the
    // carrying program's own classification says (P0-03).
    if (/\bfetch\s*\(|https?:\/\//.test(analysed) || /\bcurl\b|\bwget\b/.test(analysedLower)) {
      network = true;
      reasons.push("inline code references a network endpoint");
    }
  }

  // ---- Declared network intent (§24.1: the model states intent, policy decides) ----
  if (spec.networkIntent?.required === true) {
    network = true;
    risk = maxRisk(risk, "R3");
    reasons.push(
      spec.networkIntent.reason !== undefined && spec.networkIntent.reason.length > 0
        ? `declares network intent: ${spec.networkIntent.reason}`
        : "declares network intent",
    );
  }

  // ---- Safe local execution ----
  // A familiar executable is not enough: project-provided code may run under
  // cargo, node, python, make, or a package manager. Only fixed read-only
  // invocations qualify for the safe-auto path.
  if (readsOnly && !network && !destructive && !shellLike) {
    reasons.push(`${program} is a fixed read-only command`);
  } else if (executesProjectCode) {
    reasons.push(`${program} may execute project-provided code`);
    sideEffects.push("may write workspace or build artifacts");
  }

  // ---- Unknown program: escalate (§13.5) ----
  if (unknownProgram && !privileged && !destructive) {
    risk = maxRisk(risk, "R3");
    reasons.push(`'${program}' is not a recognized program, so its risk is escalated`);
  }

  if (reasons.length === 0) reasons.push("local execution");

  return {
    risk,
    reasons: dedupe(reasons),
    network,
    destructive,
    privileged,
    externalSideEffect,
    touchesCredentials,
    unknownProgram,
    shellLike,
    executesProjectCode,
    readsOnly,
    expectedWorkspaceWrites,
    networkIntent: spec.networkIntent?.required === true ? "required" : network ? "possible" : "none",
    executableIdentity: spec.program,
    sideEffects: dedupe(sideEffects),
  };
}

function isFixedReadOnlyInvocation(
  program: string,
  args: readonly string[],
  semantics: ProcessSemantics,
): boolean {
  if (semantics !== "direct-executable") return false;
  const command = `${program} ${args.join(" ")}`.trim();
  if (["pwd", "true", "false", "date"].includes(program) && args.length === 0) return true;
  if (program === "git" && ["status", "diff", "log", "show", "rev-parse", "ls-files", "branch"].includes(args[0] ?? "")) {
    return args.every((arg) => !/[;&|<>$`]/.test(arg));
  }
  if (["ls", "cat", "head", "tail", "wc", "sort", "uniq", "grep", "rg", "fd", "find"].includes(program)) {
    return args.length > 0 && args.every((arg) => !/[;&|<>$`]/.test(arg));
  }
  return command === "";
}

function isKnownProgram(program: string): boolean {
  return (
    SAFE_LOCAL_PROGRAMS.has(program) ||
    PRIVILEGE_PROGRAMS.has(program) ||
    NETWORK_PROGRAMS.has(program) ||
    PACKAGE_MANAGERS.has(program) ||
    [
      "git",
      "rm",
      "mv",
      "cp",
      "ls",
      "cat",
      "echo",
      "grep",
      "rg",
      "fd",
      "find",
      "sed",
      "awk",
      "head",
      "tail",
      "wc",
      "sort",
      "uniq",
      "diff",
      "chmod",
      "chown",
      "mkdir",
      "touch",
      "true",
      "false",
      "env",
      "printf",
      "test",
      "which",
      "sh",
      "bash",
      "zsh",
      "pwd",
      "date",
      "sleep",
      "tar",
      "zip",
      "unzip",
      "gzip",
      "jq",
      "yq",
      "xargs",
      "tee",
      "mkfs",
      "dd",
      "fdisk",
      "diskutil",
      "shred",
      "srm",
      "setfacl",
      "icacls",
      "psql",
      "mysql",
      "sqlite3",
      "mongosh",
      "redis-cli",
    ].includes(program)
  );
}

/** §13.5: a database migration against a non-local target is high risk. */
export function classifyDatabaseTarget(spec: CommandSpec): { risk: RiskClass; reason?: string } {
  const program = basename(spec.program);
  if (!["psql", "mysql", "sqlite3", "mongosh", "redis-cli"].includes(program)) {
    return { risk: "R0" };
  }
  const joined = spec.args.join(" ");
  const localMarkers = ["localhost", "127.0.0.1", "::1", "unix:", "file:", "./", "/tmp/"];
  const looksLocal =
    program === "sqlite3" || localMarkers.some((marker) => joined.includes(marker));
  if (looksLocal) {
    return { risk: "R2", reason: `${program} against a local target` };
  }
  return { risk: "R6", reason: `${program} against a non-local database target` };
}

function basename(program: string): string {
  const withoutQuery = program.split(/[\\/]/).pop() ?? program;
  return withoutQuery.replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}
export type CommandExecutionLane = "read" | "test" | "mutation" | "process" | "external";

export interface CommandLaneClassification {
  readonly kind: CommandExecutionLane;
  readonly conflictKeys: readonly string[];
  readonly exclusive: boolean;
  readonly reason: string;
}

/**
 * Translate the security classifier into conservative execution lanes. Unknown
 * or shell-like invocations remain process barriers; only recognized,
 * independently keyed tests are eligible for bounded parallel execution.
 */
export function classifyCommandLane(spec: CommandSpec): CommandLaneClassification {
  const classification = classifyCommand(spec);
  const program = basename(spec.program);
  const args = spec.args.map((arg) => arg.toLowerCase());
  const cwd = spec.cwd.replace(/\\/gu, "/").toLowerCase();
  const keyPrefix = `command:${cwd}`;

  if (classification.shellLike || classification.unknownProgram) {
    return {
      kind: "process",
      conflictKeys: [`${keyPrefix}:barrier`],
      exclusive: true,
      reason: classification.shellLike ? "unparsed shell or inline code" : "unknown executable",
    };
  }
  if (classification.externalSideEffect || classification.network || classification.touchesCredentials) {
    return {
      kind: "external",
      conflictKeys: [`${keyPrefix}:external`],
      exclusive: true,
      reason: "network, credential, or external side effect",
    };
  }
  if (classification.readsOnly) {
    return {
      kind: "read",
      conflictKeys: [`${keyPrefix}:read:${program}:${args.join(" ")}`],
      exclusive: false,
      reason: "fixed read-only invocation",
    };
  }

  const joined = args.join(" ");
  const writesExplicitly =
    args.some((arg) => arg === "--write" || arg === "--fix" || arg === "-w") ||
    /\b(?:install|add|update|upgrade|publish|release|deploy|generate|codegen|migrate)\b/u.test(joined);
  if (writesExplicitly) {
    return {
      kind: "mutation",
      conflictKeys: [`${keyPrefix}:workspace`],
      exclusive: true,
      reason: "recognized workspace-mutating command",
    };
  }

  const directTestProgram = new Set([
    "pytest", "jest", "vitest", "mocha", "phpunit", "tox", "nox", "mypy", "tsc",
    "eslint", "ruff", "clippy",
  ]).has(program);
  const testSubcommand = args.some((arg) =>
    /^(?:test|check|lint|typecheck|verify|build)$/u.test(arg)
  );
  if (directTestProgram || testSubcommand) {
    const sharedBuildProgram = new Set([
      "cargo", "gradle", "mvn", "dotnet", "make", "cmake", "ninja",
    ]).has(program) || args.includes("build");
    const target = args.filter((arg) => !arg.startsWith("-")).slice(0, 3).join(":") || "all";
    return {
      kind: "test",
      conflictKeys: [sharedBuildProgram
        ? `${keyPrefix}:shared-build`
        : `${keyPrefix}:test:${program}:${target}`],
      exclusive: sharedBuildProgram,
      reason: sharedBuildProgram
        ? "test/build uses a shared output directory"
        : "recognized independently keyed verification command",
    };
  }

  return {
    kind: classification.expectedWorkspaceWrites ? "mutation" : "process",
    conflictKeys: [`${keyPrefix}:workspace`],
    exclusive: true,
    reason: classification.expectedWorkspaceWrites
      ? "project-code execution may write the workspace"
      : "unclassified local process remains an ordered barrier",
  };
}
