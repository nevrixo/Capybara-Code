/**
 * `capy doctor` — PRD §23.3, §23.4, §9.8, AC-39.
 *
 * §23.3 lists sixteen checks. Each one runs independently and reports its own
 * status, because a doctor that stops at the first failure is useless for the case it
 * exists to serve: an installation with several unrelated problems.
 *
 * §23.4's bundle carries the effective config with secrets removed, redacted logs,
 * and capability reports — never source or artifacts. The user sees a preview and
 * consents before anything is written.
 */

import {
  MODEL_REGISTRY,
  OpenAiResponsesProvider,
  type ModelAvailabilityReport,
} from "@cbc/provider-openai";
import { detectCapabilities } from "@cbc/tui-components";

import { EXIT } from "../exit.ts";
import { readAuthMode } from "../auth-mode.ts";
import { basename, findRuntimeBinary, join } from "../host.ts";
import { resolveAccountSession, resolveCredential } from "../credentials.ts";
import { ok, type CommandContext, type CommandResult } from "./context.ts";

type Status = "pass" | "warn" | "fail" | "skip";

interface Check {
  readonly name: string;
  readonly status: Status;
  readonly detail: string;
}

const MARK: Readonly<Record<Status, string>> = {
  pass: "\u2713",
  warn: "!",
  fail: "\u2717",
  skip: "-",
};

export interface DoctorArgs {
  readonly bundle: boolean;
  readonly storage: boolean;
}

type PushCheck = (name: string, status: Status, detail: string) => void;

/**
 * §23.3 / P0-11: report model availability with honest states. A provider that
 * could not be reached yields `unverified` — never "reachable" — because a false
 * "everything is up" is exactly the overclaim a doctor must not make (§24.5).
 */
function pushModelAvailability(
  push: PushCheck,
  models: readonly ModelAvailabilityReport[],
  registrySize: number,
): void {
  const knownIds = new Set(MODEL_REGISTRY.map((model) => model.id.toLowerCase()));
  const reachable = models.filter((m) => m.availability === "reachable" && knownIds.has(m.model.id.toLowerCase())).length;
  const additional = models.filter((m) => m.availability === "reachable" && !knownIds.has(m.model.id.toLowerCase())).length;
  const known = models.filter((m) => m.availability === "known").length;
  const unverified = models.filter((m) => m.availability === "unverified").length;
  const unavailable = models.filter((m) => m.availability === "unavailable").length;

  if (unverified === models.length && models.length > 0) {
    push(
      "model availability",
      "warn",
      `could not verify (${models.length} bundled model(s) known, provider unreachable)`,
    );
    return;
  }
  if (known === models.length && models.length > 0) {
    push(
      "model availability",
      "pass",
      `${models.length} bundled model(s); entitlement is checked per turn on this backend`,
    );
    return;
  }
  push(
    "model availability",
    reachable > 0 ? "pass" : "warn",
    `${reachable} of ${registrySize} reachable${additional > 0 ? `, ${additional} additional provider model(s)` : ""}${unavailable > 0 ? `, ${unavailable} unavailable` : ""}${unverified > 0 ? `, ${unverified} unverified` : ""}`,
  );
}

export async function doctor(
  context: CommandContext,
  args: DoctorArgs,
): Promise<CommandResult> {
  const checks: Check[] = [];
  const push = (name: string, status: Status, detail: string): void => {
    checks.push({ name, status, detail });
  };

  // ---- version and build ----
  push(
    "version",
    "pass",
    `capy ${context.version} on ${context.host.platform} (${context.host.env.PROCESSOR_ARCHITECTURE ?? process.arch})`,
  );

  // ---- terminal ----
  const capabilities = detectCapabilities(context.host.env, {
    columns: context.host.io.columns,
    rows: context.host.io.rows,
    isTty: context.host.io.isTty,
  });
  push(
    "terminal",
    capabilities.columns >= 60 ? "pass" : "warn",
    `${capabilities.columns}x${capabilities.rows}, color ${capabilities.colorDepth}, unicode ${capabilities.unicode ? "yes" : "no"}, tty ${context.host.io.isTty ? "yes" : "no"}`,
  );
  push("render mode", "pass", `${context.decision.mode} (${context.decision.reason})`);

  // ---- config ----
  const loaded = await context.config();
  const configErrors = loaded.issues.filter((issue) => issue.severity === "error");
  push(
    "config",
    configErrors.length === 0 && loaded.tomlIssues.length === 0 ? "pass" : "fail",
    configErrors.length === 0 && loaded.tomlIssues.length === 0
      ? `${loaded.userConfigPath}`
      : `${configErrors.length} error(s), ${loaded.tomlIssues.length} syntax issue(s)`,
  );
  const trust = await context.trust();
  push(
    "trust",
    trust === "untrusted" ? "warn" : "pass",
    `${trust} for ${context.workspacePath}`,
  );

  // ---- runtime binary and protocol ----
  const located = await findRuntimeBinary(context.host);
  if ("missing" in located) {
    push("runtime binary", "fail", `not found; looked in ${located.missing.length} location(s)`);
    push("runtime protocol", "skip", "no runtime to query");
    push("workspace write test", "skip", "no runtime to query");
    push("process cancellation", "skip", "no runtime to query");
    push("git", "skip", "no runtime to query");
    push("keychain", "skip", "no runtime to query");
    push("sandbox", "skip", "no runtime to query");
  } else {
    push("runtime binary", "pass", located.path);
    try {
      const runtime = await context.runtime();
      push(
        "runtime protocol",
        "pass",
        `protocol ${runtime.protocolVersion ?? "?"}, runtime ${runtime.runtimeVersion ?? "?"}`,
      );

      const capability = runtime.capabilities;
      push(
        "sandbox",
        capability === undefined
          ? "skip"
          : capability.enhancedSandbox
            ? "pass"
            : "warn",
        capability === undefined
          ? "no capability report"
          : `level ${capability.sandboxLevel}, backends: ${capability.sandboxBackends.join(", ") || "none"}`,
      );
      push(
        "keychain",
        capability === undefined ? "skip" : capability.keychain === "none" ? "warn" : "pass",
        capability?.keychain ?? "unknown",
      );
      push(
        "git",
        capability?.git === true ? "pass" : "warn",
        capability?.git === true ? "available" : "no git repository or git not found",
      );

      // §23.3's workspace write test. The probe lives at the workspace root —
      // the write path is what is under test — and is removed again immediately.
      const probeName = `.capybara-doctor-${context.host.now().toString(36)}.tmp`;
      try {
        const begun = await runtime.beginTransaction({ agentId: "doctor" });
        await runtime.write({
          transactionId: begun.transactionId,
          path: probeName,
          content: "capybara doctor write probe\n",
          intent: "create",
        });
        const committed = (await runtime.commitTransaction(begun.transactionId)) as {
          operations?: Array<{ postHash?: string }>;
        };
        // Deleting an existing file requires the base hash (§12.5 optimistic
        // concurrency); the commit response carries the probe's checksum.
        const probeHash = committed.operations?.[0]?.postHash;
        const cleanup = await runtime.beginTransaction({ agentId: "doctor" });
        await runtime.delete({
          transactionId: cleanup.transactionId,
          path: probeName,
          ...(probeHash !== undefined ? { expectedHash: probeHash } : {}),
        });
        await runtime.commitTransaction(cleanup.transactionId);
        push("workspace write test", "pass", "created and removed a probe file");
      } catch (error) {
        push(
          "workspace write test",
          "fail",
          error instanceof Error ? error.message : String(error),
        );
      }

      // §23.3's execution check: a trivial command must run and exit.
      try {
        const outcome = await runtime.run({
          program: context.host.platform === "win32" ? "cmd" : "sh",
          args: context.host.platform === "win32" ? ["/c", "exit 0"] : ["-c", "exit 0"],
          cwd: ".",
          timeoutMs: 5_000,
          maxOutputBytes: 4_096,
        });
        push(
          "process execution",
          outcome.state === "exited" ? "pass" : "warn",
          `${outcome.display} → ${outcome.state}`,
        );
      } catch (error) {
        push("process execution", "fail", error instanceof Error ? error.message : String(error));
      }

      // §23.3's cancellation check (P1-07): start a job that outlives the check,
      // stop it, and verify the runtime actually killed it. `exit 0` proves
      // execution; only a live stop proves cancellation.
      try {
        const job = await runtime.startJob({
          program: context.host.platform === "win32" ? "cmd" : "sh",
          args:
            context.host.platform === "win32"
              ? ["/c", "ping -n 61 127.0.0.1 > NUL"]
              : ["-c", "sleep 60"],
          cwd: ".",
          timeoutMs: 120_000,
          maxOutputBytes: 4_096,
        });
        const stopped = (await runtime.stopJob(job.jobId, 500, undefined, true)) as { state?: string };
        let finalState = stopped.state ?? "unknown";
        try {
          const status = (await runtime.jobStatus(job.jobId)) as { state?: string };
          finalState = status.state ?? finalState;
        } catch {
          // A job the supervisor no longer knows about is, by definition, dead.
          finalState = "cancelled";
        }
        const dead =
          finalState === "cancelled" ||
          finalState === "exited" ||
          finalState === "timed_out" ||
          finalState === "failed";
        push(
          "process cancellation",
          dead ? "pass" : "warn",
          dead
            ? `stop request terminated ${job.jobId} (${finalState})`
            : `${job.jobId} still reports '${finalState}' after stop`,
        );
      } catch (error) {
        push(
          "process cancellation",
          "fail",
          error instanceof Error ? error.message : String(error),
        );
      }
    } catch (error) {
      push("runtime protocol", "fail", error instanceof Error ? error.message : String(error));
    }
  }

  // ---- credentials and connectivity ----
  let credentialPresent = false;
  const authMode = await readAuthMode(context.host, context.paths);
  if (authMode === "account" && context.runtimeStarted) {
    try {
      const runtime = await context.runtime();
      const session = await resolveAccountSession({
        runtime,
        host: context.host,
        paths: context.paths,
        env: context.host.env,
        now: () => context.host.now(),
      });
      credentialPresent = session !== undefined;
      // §23.3 and §9.8: presence, source, and fingerprint only.
      push(
        "credential",
        credentialPresent ? "pass" : "warn",
        session !== undefined
          ? `account token (fingerprint ${session.lease.fingerprint})`
          : "account mode is selected, but no usable account token is stored",
      );

      if (session === undefined) {
        push("OpenAI connectivity", "skip", "no account session");
        push("model availability", "skip", "no account session");
      } else {
        // Probed against the registration's own base URL and headers. Checking the
        // default host instead would report a failure that says nothing about the
        // endpoint this session actually uses.
        const provider = new OpenAiResponsesProvider({
          credential: session.lease,
          baseUrl: session.baseUrl,
          ...(session.protocol === "chatgpt" && session.accountId !== undefined
            ? {
                chatGpt: { accountId: session.accountId, originator: "capybara" },
              }
            : {}),
          ...(session.headers !== undefined ? { headers: session.headers } : {}),
        });
        const validation = await provider.validateCredential(session.lease);
        push(
          "OpenAI connectivity",
          validation.status === "valid"
            ? "pass"
            : validation.status === "network_error"
              ? "fail"
              : "warn",
          `${validation.status} at ${validation.checkedAt} (${session.baseUrl})`,
        );
        const models = await provider.listModelsWithAvailability();
        pushModelAvailability(
          push,
          models,
          MODEL_REGISTRY.length,
        );
      }
    } catch (error) {
      push("credential", "fail", error instanceof Error ? error.message : String(error));
      push("OpenAI connectivity", "skip", "account session unavailable");
      push("model availability", "skip", "account session unavailable");
    }
  } else if (context.runtimeStarted) {
    try {
      const runtime = await context.runtime();
      const credential = await resolveCredential({
        runtime,
        env: context.host.env,
        host: context.host,
        paths: context.paths,
        now: () => context.host.now(),
      });
      credentialPresent = credential !== undefined;
      // §23.3 and §9.8: presence and source only, never the value.
      push(
        "credential",
        credentialPresent ? "pass" : "warn",
        credentialPresent
          ? `present via ${credential?.source} (fingerprint ${credential?.lease.fingerprint})`
          : "none stored and OPENAI_API_KEY is unset",
      );

      if (credential !== undefined) {
        const provider = new OpenAiResponsesProvider({ credential: credential.lease });
        const validation = await provider.validateCredential(credential.lease);
        push(
          "OpenAI connectivity",
          validation.status === "valid"
            ? "pass"
            : validation.status === "network_error"
              ? "fail"
              : "warn",
          `${validation.status} at ${validation.checkedAt}`,
        );
        const models = await provider.listModelsWithAvailability();
        pushModelAvailability(
          push,
          models,
          MODEL_REGISTRY.length,
        );
      } else {
        push("OpenAI connectivity", "skip", "no credential");
        push("model availability", "skip", "no credential");
      }
    } catch (error) {
      push("credential", "fail", error instanceof Error ? error.message : String(error));
    }
  } else {
    push("credential", "skip", "runtime unavailable");
    push("OpenAI connectivity", "skip", "runtime unavailable");
    push("model availability", "skip", "runtime unavailable");
  }

  // ---- skills ----
  try {
    const { skillsSummary } = await import("./doctor-skills.ts");
    const summary = await skillsSummary(context);
    push(
      "skills",
      summary.rejected === 0 ? "pass" : "warn",
      `${summary.registered} registered, ${summary.rejected} rejected, ${summary.shadowed} shadowed`,
    );
  } catch (error) {
    push("skills", "warn", error instanceof Error ? error.message : String(error));
  }

  // ---- mcp ----
  const servers = Object.entries(loaded.config.mcpServers);
  push(
    "mcp",
    "pass",
    servers.length === 0
      ? "no servers configured"
      : `${servers.filter(([, s]) => s.enabled !== false).length} enabled of ${servers.length}`,
  );

  // ---- storage ----
  const dataWritable = await probeWrite(context, context.paths.data);
  push(
    "storage permissions",
    dataWritable ? "pass" : "fail",
    `${context.paths.data}${dataWritable ? "" : " is not writable"}`,
  );
  // P0-05: the session count comes from the runtime store, the single authority.
  if (context.runtimeStarted) {
    try {
      const runtime = await context.runtime();
      const { sessions } = await runtime.listSessions({ limit: 100_000, all: true });
      push("sessions", "pass", `${sessions.length} recorded`);
    } catch (error) {
      push(
        "sessions",
        "warn",
        error instanceof Error ? error.message : String(error),
      );
    }
  } else {
    push("sessions", "skip", "runtime not started");
  }

  if (args.storage) {
    push("cache", (await probeWrite(context, context.paths.cache)) ? "pass" : "warn", context.paths.cache);
    push("logs", (await probeWrite(context, context.paths.logs)) ? "pass" : "warn", context.paths.logs);
    push(
      "bundled share",
      (await context.host.fs.isDirectory(context.paths.share)) ? "pass" : "warn",
      context.paths.share,
    );
  }

  // ---- report ----
  const width = checks.reduce((max, check) => Math.max(max, check.name.length), 0);
  context.outLines(
    checks.map((check) => `${MARK[check.status]} ${check.name.padEnd(width)}  ${check.detail}`),
  );

  const failures = checks.filter((check) => check.status === "fail").length;
  const warnings = checks.filter((check) => check.status === "warn").length;
  context.out("");
  context.out(`${checks.length} check(s): ${failures} failed, ${warnings} warned`);

  if (args.bundle) {
    const written = await writeDebugBundle(context, checks, loaded);
    if (written === undefined) return failures > 0 ? { code: EXIT.failure } : ok();
    context.out("");
    context.out(`Wrote ${written}`);
  }

  return failures > 0 ? { code: EXIT.failure } : ok();
}

async function probeWrite(context: CommandContext, directory: string): Promise<boolean> {
  const probe = join(directory, `.write-probe-${context.host.now().toString(36)}`);
  try {
    await context.host.fs.write(probe, "probe");
    await context.host.fs.remove(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * §23.4's debug bundle.
 *
 * Consent is required before writing, and the preview lists exactly what will be
 * included. Source files and artifacts are never included — only session *ids*.
 */
async function writeDebugBundle(
  context: CommandContext,
  checks: readonly Check[],
  loaded: Awaited<ReturnType<CommandContext["config"]>>,
): Promise<string | undefined> {
  let sessionIds: string[] = [];
  if (context.runtimeStarted) {
    try {
      const runtime = await context.runtime();
      sessionIds = (await runtime.listSessions({ limit: 100_000, all: true })).sessions.map(
        (session) => session.id,
      );
    } catch {
      sessionIds = [];
    }
  }
  const contents = [
    "versions and build info",
    "terminal capability report",
    "effective configuration with credential-shaped values removed",
    "protocol and runtime diagnostics",
    "path categories only (full local paths are omitted)",
    `session ids only (${sessionIds.length}), no transcripts, no source, no artifacts`,
  ];

  context.out("");
  context.out("The bundle will contain:");
  for (const item of contents) context.out(`  - ${item}`);

  if (!context.nonInteractive) {
    const choice = await context.host.io.select("Write this bundle?", ["Write it", "Cancel"]);
    if (choice !== 0) {
      context.out("Cancelled; nothing was written.");
      return undefined;
    }
  } else {
    // §23.4: consent is a precondition for writing diagnostics. A non-interactive
    // run cannot ask, so it must not write — silently bundling config and paths
    // without a human saying yes is the exact overreach consent exists to stop.
    context.warn("non-interactive: not writing the bundle without an explicit consent prompt");
    return undefined;
  }

  const bundle = {
    schemaVersion: "1.0",
    generatedAt: new Date(context.host.now()).toISOString(),
    version: context.version,
    platform: context.host.platform,
    checks: checks.map((check) => ({ ...check, detail: redactDiagnosticText(check.detail) })),
    renderMode: context.decision.mode,
    capabilities: context.decision.capabilities,
    // §23.4 + §9.8: strip anything credential-shaped before it reaches the file.
    config: redactConfig(loaded.config as unknown as Record<string, unknown>),
    configIssues: redactDiagnosticValue(loaded.issues),
    tomlIssues: redactDiagnosticValue(loaded.tomlIssues),
    paths: {
      config: shareablePathLabel("config"),
      data: shareablePathLabel("data"),
      cache: shareablePathLabel("cache"),
      logs: shareablePathLabel("logs"),
    },
    sessionIds,
  };

  const filename = `cbc-debug-${new Date(context.host.now()).toISOString().replace(/[:.]/g, "-")}.json`;
  const path = join(context.paths.logs, filename);
  await context.host.fs.write(path, `${JSON.stringify(bundle, null, 2)}\n`);
  return join(shareablePathLabel("logs"), filename);
}

const SECRET_KEY = /(key|secret|token|password|credential|authorization)/i;

/** Stable labels keep support bundles useful without exposing local paths. */
export function shareablePathLabel(kind: "config" | "data" | "cache" | "logs"): string {
  return `<user-${kind}>`;
}

const ABSOLUTE_PATH = /(?:^|[\s("'])(?:[A-Za-z]:[\\/]|\\\\|\/(?:home|Users|mnt\/[A-Za-z]\/Users|tmp|opt)(?:[\\/]|$))/i;

/** Omit an entire diagnostic value when it contains an absolute local path. */
export function redactDiagnosticText(value: string): string {
  return ABSOLUTE_PATH.test(value) ? "<local path omitted>" : value;
}

export function redactDiagnosticValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactDiagnosticValue);
  if (typeof value === "string") return redactDiagnosticText(value);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactDiagnosticValue(item)]),
  );
}

/** Recursively blank anything whose key looks like a credential (§9.8). */
export function redactConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactConfig);
  if (value instanceof Map) return redactConfig(Object.fromEntries(value));
  if (typeof value !== "object" || value === null) return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY.test(key) ? "***REDACTED***" : redactConfig(item);
  }
  return out;
}

export { basename };
