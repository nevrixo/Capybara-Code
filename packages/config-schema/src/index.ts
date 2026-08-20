/**
 * `@cbc/config-schema` — configuration schema, TOML reading, precedence, and
 * validation (PRD §21).
 */

export * from "./schema.ts";
export * from "./toml.ts";
export * from "./key-status.ts";
export * from "./performance-rollbacks.ts";

import {
  environmentLayer,
  mergeConfig,
  type ConfigLayer,
  type ConfigSource,
  type EffectiveConfig,
} from "./schema.ts";
import { normalizeConfigKeys, parseToml, type TomlIssue } from "./toml.ts";

export interface LoadConfigInput {
  /** Raw contents of the one global user config file, if it exists. */
  readonly userToml?: string;
  readonly env: Record<string, string | undefined>;
  /** Already-parsed CLI flags as dotted paths. */
  readonly cliOverrides?: ConfigLayer;
  /** Interactive `/model`, `/mode`, `/effort` overrides. */
  readonly sessionOverrides?: ConfigLayer;
  /** @deprecated Project configuration is ignored; retained for source compatibility. */
  readonly projectToml?: string;
  /** @deprecated Project-local configuration is ignored. */
  readonly projectLocalToml?: string;
  /** @deprecated Workspace trust no longer participates in configuration loading. */
  readonly projectTrusted?: boolean;
}

export interface LoadConfigResult extends EffectiveConfig {
  readonly tomlIssues: Array<TomlIssue & { source: ConfigSource }>;
}

/** Assemble the effective configuration following global-only precedence. */
export function loadConfig(input: LoadConfigInput): LoadConfigResult {
  const tomlIssues: Array<TomlIssue & { source: ConfigSource }> = [];
  const layers: Array<{ source: ConfigSource; values: ConfigLayer }> = [];

  if (input.userToml !== undefined) {
    const parsed = parseToml(input.userToml);
    tomlIssues.push(...parsed.issues.map((i) => ({ ...i, source: "user" as ConfigSource })));
    layers.push({ source: "user", values: normalizeConfigKeys(parsed.values) });
  }

  layers.push({ source: "environment", values: environmentLayer(input.env) });

  if (input.cliOverrides) layers.push({ source: "cli", values: input.cliOverrides });
  if (input.sessionOverrides) layers.push({ source: "session", values: input.sessionOverrides });

  const merged = mergeConfig(layers);
  // The current provider contract exposes one supported prompt-cache lifetime.
  // Preserve the validation warning/provenance for the requested value, but make
  // the effective runtime config truthful instead of silently sending 30 minutes
  // while reporting another TTL.
  const config = merged.config.model.cache.ttlMinutes === 30
    ? merged.config
    : {
        ...merged.config,
        model: {
          ...merged.config.model,
          cache: { ...merged.config.model.cache, ttlMinutes: 30 },
        },
      };
  return { ...merged, config, tomlIssues };
}
