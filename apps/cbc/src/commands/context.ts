/**
 * Shared command context — PRD §8.1, §13.6, §21.2, §22.1.
 *
 * Every command receives one of these instead of reaching for globals. The two
 * interesting parts are both about ordering:
 *
 *   - The runtime is started lazily. §22.1's startup budget and AC-04's "paint
 *     before any network call" both fail if a config-only operation spawns a sidecar, so
 *     commands that never touch the workspace never pay for one.
 *   - Configuration is global and independent of workspace trust. Trust is still
 *     resolved before executable workspace integrations are launched.
 */

import type { CbcConfig } from "@cbc/config-schema";
import type { TrustState } from "@cbc/permissions";

import { CliError, EXIT, type ExitCode } from "../exit.ts";
import { expandHome, join, resolvePaths, type CbcPaths, type Host } from "../host.ts";
import { LineWriter, decideRenderMode, type RenderDecision } from "../output.ts";
import { Runtime } from "../runtime.ts";
import {
  loadEffectiveConfig,
  readTrustStore,
  trustStateFor,
  type LoadedConfig,
  type TrustStore,
} from "../state.ts";

export interface CommandContextOptions {
  readonly host: Host;
  readonly version: string;
  /** Set by capy run: never prompt. */
  readonly nonInteractive?: boolean;
}

export class CommandContext {
  readonly host: Host;
  readonly paths: CbcPaths;
  readonly version: string;
  readonly workspacePath: string;
  readonly decision: RenderDecision;
  readonly writer: LineWriter;
  readonly nonInteractive: boolean;
  #runtime: Runtime | undefined;
  #config: LoadedConfig | undefined;
  #trust: TrustState | undefined;
  #trustStore: TrustStore | undefined;
  #runtimeNotificationListeners = new Set<(method: string, params: unknown) => void>();
  #diagnosticSink: ((text: string) => void) | undefined;

  constructor(options: CommandContextOptions) {
    this.host = options.host;
    this.version = options.version;
    this.paths = resolvePaths(options.host);
    // Normalize host.cwd because a trailing separator must not change the trust key.
    this.workspacePath = resolveWorkspace(options.host, options.host.cwd);
    this.nonInteractive = options.nonInteractive ?? !options.host.io.isTty;
    this.decision = decideRenderMode({
      host: options.host,
      rendererAvailable: options.host.io.isTty,
    });
    this.writer = new LineWriter(options.host, this.decision);
  }

  /** Print a line of normal output. */
  out(text: string): void {
    this.writer.text(text);
  }

  /**
   * Print text that came from an external source (a Skill body, an HTTP error,
   * workspace instructions, tool output). Sanitized so a hostile source cannot
   * drive the terminal (P1-01).
   */
  untrusted(text: string): void {
    this.writer.untrustedText(text);
  }

  outLines(lines: readonly string[]): void {
    this.writer.lines(lines);
  }

  /** Print a diagnostic through the active renderer, or stderr headlessly. */
  warn(text: string): void {
    if (this.#diagnosticSink !== undefined) {
      this.#diagnosticSink(text);
      return;
    }
    this.writer.diagnostic(text);
  }

  setDiagnosticSink(sink: ((text: string) => void) | undefined): void {
    this.#diagnosticSink = sink;
  }

  /**
   * The trust state for this workspace.
   *
   * Read from the host store first so trust lookup works without a sidecar.
   * When the runtime is already up, its answer wins: §13.6 keys trust on filesystem
   * identity, and only the runtime can see that.
   */
  async trust(): Promise<TrustState> {
    if (this.#trust !== undefined) return this.#trust;
    const store = await this.trustStore();
    const identity = await this.host.fs.statIdentity?.(this.workspacePath);
    this.#trust = trustStateFor(store, this.workspacePath, identity);
    return this.#trust;
  }

  async trustStore(): Promise<TrustStore> {
    if (this.#trustStore === undefined) {
      this.#trustStore = await readTrustStore(this.host, this.paths);
    }
    return this.#trustStore;
  }

  /** Override the cached trust state after the user decides (§7.1). */
  setTrust(state: TrustState, store?: TrustStore): void {
    this.#trust = state;
    if (store !== undefined) this.#trustStore = store;

  }

  async config(): Promise<LoadedConfig> {
    if (this.#config !== undefined) return this.#config;
    this.#config = await loadEffectiveConfig(this.host);
    return this.#config;
  }

  /** The effective config, or a config error if it has blocking issues (§21.7). */
  async requireConfig(): Promise<CbcConfig> {
    const loaded = await this.config();
    const errors = loaded.issues.filter((issue) => issue.severity === "error");
    if (errors.length > 0) {
      throw new CliError(
        EXIT.config,
        `configuration has ${errors.length} error(s)`,
        errors.map((issue) => `  ${issue.path}: ${issue.message}`),
      );
    }
    return loaded.config;
  }

  /** Subscribe to asynchronous sidecar notifications without blocking RPC calls. */
  onRuntimeNotification(listener: (method: string, params: unknown) => void): () => void {
    this.#runtimeNotificationListeners.add(listener);
    return () => {
      this.#runtimeNotificationListeners.delete(listener);
    };
  }

  /** Start the sidecar on first use, then reuse it. */
  async runtime(): Promise<Runtime> {
    if (this.#runtime !== undefined) return this.#runtime;
    // P0-04: enforcement belongs to the runtime. The configured sandbox level
    // and shell-network policy travel with the handshake; the runtime clamps
    // the level to what the host can enforce and applies it at every spawn. A
    // config failure must not be masked here, so a blocking config surfaces
    // as the usual §21.7 error instead of a silent default.
    const config = await this.requireConfig();
    this.#runtime = await Runtime.start({
      host: this.host,
      workspace: this.workspacePath,
      dataDir: this.paths.data,
      clientVersion: this.version,
      pty: true,
      sandboxLevel: config.sandbox.level,
      networkForShell: config.sandbox.networkForShell,
      interactionMode: config.agent.interactionMode ?? (config.agent.permissionMode === "plan" ? "plan" : "build"),
      onNotification: (method, params) => {
        for (const listener of this.#runtimeNotificationListeners) {
          try {
            listener(method, params);
          } catch {
            // A presentation listener must never break the runtime read loop.
          }
        }
      },
      onStderr: (line) => {
        if (this.host.env.CBC_DEBUG === "1") this.warn("runtime: " + line);
      },
      onHealthChange: (health, detail) => {
        if (health === "degraded" || health === "fatal") {
          this.warn(`runtime ${health}${detail !== undefined ? `: ${detail}` : ""}`);
        }
      },
    });
    return this.#runtime;
  }

  /** Whether a sidecar was started, so shutdown can skip the work. */
  get runtimeStarted(): boolean {
    return this.#runtime !== undefined;
  }

  async shutdown(): Promise<void> {
    if (this.#runtime === undefined) return;
    const runtime = this.#runtime;
    this.#runtime = undefined;
    await runtime.stop().catch(() => undefined);
  }
}

/** A command's result: an exit code plus whether the runtime should stay up. */
export interface CommandResult {
  readonly code: ExitCode;
}

export function ok(): CommandResult {
  return { code: EXIT.ok };
}

export function failure(code: ExitCode): CommandResult {
  return { code };
}

/**
 * Resolve the workspace directory.
 *
 * `~` is expanded, separators are normalized, and `.`/`..` segments are collapsed, so a
 * trust record written from PowerShell still matches the same directory entered from
 * bash. Collapsing is not cosmetic: historical path-based trust writes could key a record on
 * `<cwd>/.`, which never matched the workspace, so the decision silently did nothing.
 *
 * Canonicalization proper — symlinks, junctions, case folding — is the runtime's job.
 * §14.2 puts that check on the trusted side of the boundary, and doing it here would
 * duplicate an invariant that has to hold there anyway.
 */
export function resolveWorkspace(host: Host, requested?: string): string {
  if (requested === undefined || requested.length === 0) return host.cwd;
  const expanded = expandHome(requested, host.homeDir).replace(/\\/g, "/");
  const absolute =
    /^[a-zA-Z]:\//.test(expanded) || expanded.startsWith("/")
      ? expanded
      : join(host.cwd, expanded);
  return collapseDotSegments(absolute);
}

/**
 * Collapse `.` and `..` in an already-absolute path.
 *
 * `..` is resolved rather than preserved, unlike the tool-argument normalizer: there,
 * keeping it lets the approval card show a traversal attempt. Here the string becomes a
 * trust key and a session directory name, so two spellings of one directory have to
 * produce one value.
 */
export function collapseDotSegments(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const driveMatch = /^([a-zA-Z]:)\//.exec(normalized);
  const prefix = driveMatch?.[1] !== undefined ? `${driveMatch[1]}/` : normalized.startsWith("/") ? "/" : "";
  const body = normalized.slice(prefix.length);

  const segments: string[] = [];
  for (const segment of body.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      // A `..` above the root is dropped rather than escaping the prefix.
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const joined = `${prefix}${segments.join("/")}`;
  return joined.length > 1 ? joined.replace(/\/+$/, "") : joined;
}
