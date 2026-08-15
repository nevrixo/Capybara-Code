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
  /** Raw contents of the user config file, if it exists. */
  readonly userToml?: string;
  /** Raw contents of the project config file, if it exists. */
  readonly projectToml?: string;
  readonly projectLocalToml?: string;
  /** §21.3: the project layer is dropped entirely when the project is untrusted. */
  readonly projectTrusted: boolean;
  readonly env: Record<string, string | undefined>;
  /** Already-parsed CLI flags as dotted paths. */
  readonly cliOverrides?: ConfigLayer;
  /** Interactive `/model`, `/mode`, `/effort` overrides. */
  readonly sessionOverrides?: ConfigLayer;
}

export interface LoadConfigResult extends EffectiveConfig {
  readonly tomlIssues: Array<TomlIssue & { source: ConfigSource }>;
  readonly projectLayerApplied: boolean;
  readonly projectLocalLayerApplied: boolean;
}

/** Assemble the effective configuration following §21.2 precedence. */
export function loadConfig(input: LoadConfigInput): LoadConfigResult {
  const tomlIssues: Array<TomlIssue & { source: ConfigSource }> = [];
  const layers: Array<{ source: ConfigSource; values: ConfigLayer }> = [];

  if (input.userToml !== undefined) {
    const parsed = parseToml(input.userToml);
    tomlIssues.push(...parsed.issues.map((i) => ({ ...i, source: "user" as ConfigSource })));
    layers.push({ source: "user", values: normalizeConfigKeys(parsed.values) });
  }

  let projectLayerApplied = false;
  if (input.projectToml !== undefined && input.projectTrusted) {
    const parsed = parseToml(input.projectToml);
    tomlIssues.push(...parsed.issues.map((i) => ({ ...i, source: "project" as ConfigSource })));
    layers.push({ source: "project", values: normalizeConfigKeys(parsed.values) });
    projectLayerApplied = true;
  }

  let projectLocalLayerApplied = false;
  if (input.projectLocalToml !== undefined && input.projectTrusted) {
    const parsed = parseToml(input.projectLocalToml);
    tomlIssues.push(...parsed.issues.map((i) => ({ ...i, source: "project-local" as ConfigSource })));
    layers.push({ source: "project-local", values: normalizeConfigKeys(parsed.values) });
    projectLocalLayerApplied = true;
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
  return { ...merged, config, tomlIssues, projectLayerApplied, projectLocalLayerApplied };
}
