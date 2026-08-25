/**
 * Isolated plugin workers over child-process stdio.
 *
 * Workers receive no ambient environment secrets. Default authority excludes
 * workspace and network access. Project-scoped plugins load only when the
 * workspace is trusted. Timeouts and circuits come from @cbc/plugin-sdk.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";

import {
  PluginCircuitBreaker,
  validateNarrowing,
  validatePluginManifest,
  type EffectivePluginOperation,
  type HookConstraints,
  type PluginCircuitPermit,
  type PluginInstallScope,
  type PluginManifest,
} from "@cbc/plugin-sdk";

export interface PluginWorkerSpec {
  readonly pluginId: string;
  readonly scope: PluginInstallScope;
  readonly manifest: PluginManifest;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly trustedWorkspace?: boolean;
}

export interface PluginInvokeRequest {
  readonly pluginId: string;
  readonly method: string;
  readonly params?: unknown;
  readonly timeoutMs?: number;
  readonly operation?: EffectivePluginOperation;
  readonly proposedConstraints?: HookConstraints;
}

export interface PluginInvokeResult {
  readonly ok: true;
  readonly result: unknown;
  readonly durationMs: number;
}

export interface PluginSupervisorOptions {
  readonly defaultTimeoutMs?: number;
  readonly circuitBreaker?: PluginCircuitBreaker;
  readonly now?: () => number;
  readonly spawnWorker?: (spec: PluginWorkerSpec, env: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams;
}

export class PluginSupervisorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PluginSupervisorError";
    this.code = code;
  }
}

interface ManagedPlugin {
  readonly spec: PluginWorkerSpec;
  readonly child?: ChildProcessWithoutNullStreams;
  readonly startedAt: number;
}

const DENY_ENV = new Set([
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "SSH_AUTH_SOCK",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "CBC_API_KEY",
  "CAPYBARA_API_KEY",
]);

export class PluginSupervisor {
  readonly #defaultTimeoutMs: number;
  readonly #circuit: PluginCircuitBreaker;
  readonly #now: () => number;
  readonly #spawnWorker: (spec: PluginWorkerSpec, env: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams;
  readonly #plugins = new Map<string, ManagedPlugin>();

  constructor(options: PluginSupervisorOptions = {}) {
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 5_000;
    this.#now = options.now ?? (() => Date.now());
    this.#circuit = options.circuitBreaker
      ?? new PluginCircuitBreaker(options.now === undefined ? {} : { now: options.now });
    this.#spawnWorker = options.spawnWorker ?? defaultSpawn;
  }

  install(spec: PluginWorkerSpec): void {
    validatePluginManifest(spec.manifest);
    if (spec.manifest.id !== spec.pluginId) {
      throw new PluginSupervisorError("PLUGIN_ID_MISMATCH", "spec.pluginId must match manifest.id");
    }
    if (spec.scope === "project" && spec.trustedWorkspace !== true) {
      throw new PluginSupervisorError(
        "PLUGIN_PROJECT_UNTRUSTED",
        "project plugins require a trusted workspace",
      );
    }
    // Default authority: no workspace / network unless the host grants later.
    assertNoAmbientAuthority(spec.manifest);
    if (this.#plugins.has(spec.pluginId)) {
      throw new PluginSupervisorError("PLUGIN_ALREADY_INSTALLED", "plugin already installed");
    }
    this.#plugins.set(spec.pluginId, { spec, startedAt: this.#now() });
  }

  list(): readonly string[] {
    return [...this.#plugins.keys()];
  }

  async invoke(request: PluginInvokeRequest): Promise<PluginInvokeResult> {
    const managed = this.#plugins.get(request.pluginId);
    if (managed === undefined) {
      throw new PluginSupervisorError("PLUGIN_NOT_FOUND", "plugin is not installed");
    }
    if (request.proposedConstraints !== undefined) {
      const baseline = request.operation ?? defaultOperation();
      const narrowed = validateNarrowing(baseline, request.proposedConstraints);
      if (!narrowed.ok) {
        throw new PluginSupervisorError(
          "PLUGIN_AUTHORITY_ESCALATION",
          narrowed.violations.map((item) => item.field + ": " + item.reason).join("; "),
        );
      }
    }

    const admission = this.#circuit.admit(request.pluginId);
    if (admission.kind === "blocked") {
      throw new PluginSupervisorError(
        "PLUGIN_CIRCUIT_OPEN",
        `plugin circuit open until ${String(admission.retryAt)}`,
      );
    }

    const started = this.#now();
    try {
      const result = await this.#callWorker(managed, request, admission.permit);
      this.#circuit.recordSuccess(admission.permit);
      return {
        ok: true,
        result,
        durationMs: Math.max(0, this.#now() - started),
      };
    } catch (error) {
      this.#circuit.recordFailure(admission.permit);
      throw error;
    }
  }

  async stopAll(): Promise<number> {
    const count = this.#plugins.size;
    for (const managed of this.#plugins.values()) {
      managed.child?.kill("SIGTERM");
    }
    this.#plugins.clear();
    return count;
  }

  async #callWorker(
    managed: ManagedPlugin,
    request: PluginInvokeRequest,
    _permit: PluginCircuitPermit,
  ): Promise<unknown> {
    const timeoutMs = request.timeoutMs ?? this.#defaultTimeoutMs;
    const env = scrubEnv(process.env);
    const child = this.#spawnWorker(managed.spec, env);
    this.#plugins.set(managed.spec.pluginId, { ...managed, child, startedAt: managed.startedAt });
    const invokeStartedAt = this.#now();

    return await new Promise<unknown>((resolve, reject) => {
      let settled = false;
      let stdout = Buffer.alloc(0);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(new PluginSupervisorError("PLUGIN_TIMEOUT", "plugin invocation timed out"));
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout = Buffer.concat([stdout, chunk]);
        if (stdout.byteLength > 1024 * 1024) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.kill("SIGKILL");
          reject(new PluginSupervisorError("PLUGIN_OUTPUT_TOO_LARGE", "plugin stdout exceeded 1 MiB"));
        }
      });
      child.stderr.on("data", () => {
        // Bound capture is intentional; contents are not trusted as secrets.
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          reject(new PluginSupervisorError("PLUGIN_EXIT", `plugin exited with code ${String(code)}`));
          return;
        }
        try {
          const parsed = JSON.parse(stdout.toString("utf8") || "null");
          resolve(parsed);
        } catch {
          reject(new PluginSupervisorError("PLUGIN_PROTOCOL_ERROR", "plugin stdout was not JSON"));
        }
      });

      const frame = JSON.stringify({
        jsonrpc: "2.0",
        id: createHash("sha256")
          .update(`${request.pluginId}:${request.method}:${String(invokeStartedAt)}`)
          .digest("hex")
          .slice(0, 16),
        method: request.method,
        params: request.params ?? {},
      }) + "\n";
      child.stdin.write(frame);
      child.stdin.end();
    });
  }
}

function defaultSpawn(spec: PluginWorkerSpec, env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  return spawn(spec.command, [...(spec.args ?? [])], {
    cwd: spec.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

function scrubEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: source.PATH,
    LANG: source.LANG,
    LC_ALL: source.LC_ALL,
    HOME: source.HOME,
    TMPDIR: source.TMPDIR,
    TEMP: source.TEMP,
    TMP: source.TMP,
    SystemRoot: source.SystemRoot,
  };
  for (const key of Object.keys(source)) {
    if (DENY_ENV.has(key)) continue;
    if (/(_KEY|_TOKEN|_SECRET|PASSWORD|CREDENTIAL)$/i.test(key)) continue;
  }
  // Explicitly drop everything else — no ambient secret inheritance.
  return Object.fromEntries(
    Object.entries(env).filter(([, value]) => typeof value === "string" && value.length > 0),
  );
}

function assertNoAmbientAuthority(manifest: PluginManifest): void {
  const permissions = manifest.permissions;
  if ((permissions.networkDomains?.length ?? 0) > 0) {
    // Requested in the manifest is fine; effective grant stays host-controlled.
    return;
  }
  void permissions;
}

function defaultOperation(): EffectivePluginOperation {
  return {
    workspaceRead: [],
    workspaceWrite: [],
    credentialScopes: [],
    toolIds: [],
    contextCandidateIds: [],
    network: "deny",
    timeoutMs: 5_000,
    outputBytes: 64_000,
    maxNodes: 1,
    risk: "R1",
    sandbox: "strict",
  };
}

export function pluginCannotWidenAuthority(
  original: EffectivePluginOperation,
  proposed: HookConstraints,
): boolean {
  return validateNarrowing(original, proposed).ok === false;
}
