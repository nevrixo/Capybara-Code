/**
 * Provider construction — PRD §10.1, §10.6, §19.4, AC-47.
 *
 * §19.4 keeps every OpenAI SDK object and Responses API event inside
 * `provider-openai`; this module is the single place the app chooses *which*
 * `ModelProvider` to use, and it deals only in the neutral interface.
 *
 * AC-47 requires the whole agent loop to be exercisable without a network. That is
 * why `CBC_MOCK_PROVIDER` exists: it points at a JSON script of turns, so the eval
 * harness and PTY tests drive real sessions deterministically.
 */

import { createHash } from "node:crypto";

import {
  MockProvider,
  OpenAiResponsesProvider,
  type CredentialLease,
  type HostedTool,
  type ModelProvider,
  type ProviderTransport,
  type ScriptedStep,
} from "@cbc/provider-openai";

import type { OpenAiAuthMode } from "./auth-mode.ts";
import { CliError, EXIT } from "./exit.ts";
import type { Host } from "./host.ts";

export interface ProviderChoice {
  readonly provider: ModelProvider;
  /** Where the credential came from, for `/status` and the status bar. */
  readonly credentialSource: string;
  readonly mocked: boolean;
}

export interface BuildProviderOptions {
  readonly host: Host;
  readonly credential?: CredentialLease;
  readonly credentialSource?: string;
  readonly authMode?: OpenAiAuthMode;
  readonly readOnly?: boolean;
  /** §10.6 privacy-preserving identifier, derived from the installation id. */
  readonly safetyIdentifier?: string;
  /**
   * The base URL this credential is valid against.
   *
   * Supplied by the caller for an account session, where §9.6 makes the URL part of
   * the registration rather than a free-floating setting. It outranks
   * `OPENAI_BASE_URL`: an environment variable that redirected an account token to
   * another host would be sending a bearer token somewhere it was never minted for.
   */
  readonly baseUrl?: string;
  /** Extra headers the deployment requires, from the registration. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly accountProtocol?: "standard" | "chatgpt";
  readonly transport?: ProviderTransport;
  readonly serviceTier?: "standard" | "fast";
  readonly nativeCompaction?: boolean;
  readonly compactionThresholdTokens?: number;
  readonly enableToolSearch?: boolean;
  /** Non-secret account selector extracted from the ChatGPT token. */
  readonly chatGptAccountId?: string;
  /** Explicit Responses hosted tools; omitted keeps network-backed tools disabled. */
  readonly hostedTools?: readonly HostedTool[];
  /** Required to use hosted tools through the ChatGPT account backend. */
  readonly allowChatGptHostedTools?: boolean;
}

/**
 * Build the provider for this run.
 *
 * The mock is checked first so a test environment can never accidentally reach the
 * network, even if a real credential happens to be present.
 */
export async function buildProvider(
  options: BuildProviderOptions,
): Promise<ProviderChoice> {
  const scriptPath = options.host.env.CBC_MOCK_PROVIDER;
  if (scriptPath !== undefined && scriptPath.length > 0) {
    return {
      provider: await loadMockProvider(options.host, scriptPath),
      credentialSource: "mock",
      mocked: true,
    };
  }

  if (options.credential === undefined) {
    // Account mode gets its own remedy. "No credential" is misleading there: the
    // usual causes are a refresh that could not be completed or a revoked session,
    // and `capy auth api` would silently change who is billed.
    if (options.authMode === "account") {
      throw new CliError(EXIT.auth, "the account session is not usable", [
        "The stored account token is missing, expired beyond refresh, or revoked.",
        "Run `capy auth status` for detail, then `capy auth login` to sign in again.",
      ]);
    }
    throw new CliError(EXIT.auth, "no OpenAI credential is available", [
      "Run `capy auth api` or set OPENAI_API_KEY.",
      "ChatGPT sign-in credentials are not general OpenAI API credentials and are not reused.",
    ]);
  }
  const isChatGpt = options.accountProtocol === "chatgpt";
  if (isChatGpt && options.chatGptAccountId === undefined) {
    throw new CliError(EXIT.auth, "the ChatGPT account selector is missing", [
      "The stored token is incomplete or predates ChatGPT login support.",
      "Run `capy auth login` again.",
    ]);
  }


  const envBaseUrl = options.host.env.OPENAI_BASE_URL;
  const baseUrl =
    options.baseUrl !== undefined && options.baseUrl.length > 0 ? options.baseUrl : envBaseUrl;
  const hostedTools = options.hostedTools ?? hostedToolsFromEnvironment(options.host.env.CBC_HOSTED_TOOLS);
  const allowChatGptHostedTools =
    options.allowChatGptHostedTools !== undefined
      ? options.allowChatGptHostedTools
      : truthyEnvironment(options.host.env.CBC_ALLOW_CHATGPT_HOSTED_TOOLS);
  return {
    provider: new OpenAiResponsesProvider({
      credential: options.credential,
      ...(baseUrl !== undefined && baseUrl.length > 0 ? { baseUrl } : {}),
      ...(options.headers !== undefined ? { headers: options.headers } : {}),
      ...(isChatGpt
        ? {
            chatGpt: {
              accountId: options.chatGptAccountId!,
              originator: "capybara",
            },
          }
        : {}),
      ...(!isChatGpt && options.safetyIdentifier !== undefined
        ? { safetyIdentifier: options.safetyIdentifier }
        : {}),
      ...(!isChatGpt && options.host.env.OPENAI_ORG_ID !== undefined
        ? { organization: options.host.env.OPENAI_ORG_ID }
        : {}),
      ...(!isChatGpt && options.host.env.OPENAI_PROJECT_ID !== undefined
        ? { project: options.host.env.OPENAI_PROJECT_ID }
        : {}),
      ...(hostedTools !== undefined ? { hostedTools } : {}),
      ...(options.transport !== undefined ? { transport: options.transport } : {}),
      ...(options.serviceTier !== undefined ? { serviceTier: options.serviceTier } : {}),
      ...(options.nativeCompaction !== undefined ? { nativeCompaction: options.nativeCompaction } : {}),
      ...(options.compactionThresholdTokens !== undefined ? { compactionThresholdTokens: options.compactionThresholdTokens } : {}),
      ...(options.enableToolSearch !== undefined ? { enableToolSearch: options.enableToolSearch } : {}),
      ...(isChatGpt && allowChatGptHostedTools ? { allowChatGptHostedTools: true } : {}),
    }),
    credentialSource: options.credentialSource ?? options.credential.source,
    mocked: false,
  };
}

/**
 * Parse the explicit hosted-tool opt-in used by the CLI.
 *
 * An unset variable is deliberately different from `off`: the former leaves the
 * provider default untouched, while the latter lets a shell profile disable a
 * previously supplied value without changing the code path.
 */
export function hostedToolsFromEnvironment(raw: string | undefined): readonly HostedTool[] | undefined {
  const value = raw?.trim();
  if (value === undefined || value.length === 0) return undefined;
  if (/^(?:off|none|disabled)$/iu.test(value)) return [];

  const tools: HostedTool[] = [];
  const seen = new Set<HostedTool["type"]>();
  for (const token of value.split(/[\s,]+/u).filter((part) => part.length > 0)) {
    const normalized = token.toLowerCase();
    const type = normalized === "web" || normalized === "web_search"
      ? "web_search_preview"
      : normalized === "image" || normalized === "image_generation"
        ? "image_generation"
        : undefined;
    if (type === undefined) {
      throw new CliError(EXIT.config, `CBC_HOSTED_TOOLS contains an unsupported tool '${token}'`, [
        "Use web_search_preview and/or image_generation, separated by commas.",
      ]);
    }
    if (seen.has(type)) continue;
    seen.add(type);
    tools.push({ type });
  }
  return tools;
}

function truthyEnvironment(raw: string | undefined): boolean {
  return raw !== undefined && /^(?:1|true|yes|on)$/iu.test(raw.trim());
}

/**
 * Load a scripted provider from disk.
 *
 * The script is either a bare array of steps or `{ steps, repeatLast }`. Both shapes
 * are accepted because the common case in a fixture is a plain array and requiring
 * the wrapper would be friction with no benefit.
 */
export async function loadMockProvider(host: Host, path: string): Promise<MockProvider> {
  const raw = await host.fs.read(path);
  if (raw === undefined) {
    throw new CliError(EXIT.config, `CBC_MOCK_PROVIDER points at a file that does not exist`, [
      path,
    ]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CliError(
      EXIT.config,
      `CBC_MOCK_PROVIDER is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      [path],
    );
  }

  const steps: ScriptedStep[] = Array.isArray(parsed)
    ? (parsed as ScriptedStep[])
    : ((parsed as { steps?: ScriptedStep[] }).steps ?? []);
  const repeatLast =
    !Array.isArray(parsed) && (parsed as { repeatLast?: boolean }).repeatLast === true;

  if (steps.length === 0) {
    throw new CliError(EXIT.config, "the mock provider script has no steps", [path]);
  }

  return new MockProvider({ steps, ...(repeatLast ? { repeatLast: true } : {}) });
}

/**
 * §10.6's `safety_identifier`.
 *
 * A stable hash of the installation id and a salt, never the user's name, path, or
 * anything else identifying. §23.5 forbids collecting identifying data by default, and
 * this value has to be stable across turns for the provider to be able to use it at
 * all — so it is derived rather than random per run.
 */
export function safetyIdentifierFor(installationId: string, salt = "capybara-code"): string {
  return `cbc_${createHash("sha256").update(`${salt}:${installationId}`).digest("hex").slice(0, 16)}`;
}

/**
 * Read or create the installation id.
 *
 * Stored in the data directory rather than the config file so it is not something a
 * user is invited to edit, and so exporting a config never carries it.
 */
export async function installationId(host: Host, dataDir: string): Promise<string> {
  const path = `${dataDir}/installation-id`;
  const existing = await host.fs.read(path);
  if (existing !== undefined && existing.trim().length > 0) return existing.trim();

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const id = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  await host.fs.mkdirp(dataDir);
  await host.fs.write(path, `${id}\n`);
  return id;
}
