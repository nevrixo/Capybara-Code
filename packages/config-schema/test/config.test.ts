/**
 * Configuration tests — PRD §21, §25.4 ("config merge is deterministic"),
 * PERM-001.
 */

import { describe, expect, test } from "bun:test";

import {
  configEnumValues,
  configKeyInfo,
  defaultConfig,
  environmentLayer,
  loadConfig,
  mergeConfig,
  normalizeConfigPath,
  normalizeConfigKeys,
  parseToml,
  readPath,
  resolvePaths,
  writePath,
} from "../src/index.ts";

/** The example config from PRD §21.4, verbatim. */
const EXAMPLE_CONFIG = `
[ui]
theme = "capybara-dark"
color = "auto"
mouse = true
animations = true
show_cost = true
status_density = "auto"

[model]
profile = "auto"
default = "gpt-5.6"
reasoning_mode = "standard"
reasoning_effort = "medium"
soft_context_tokens = 96000
max_output_tokens = 12000

[agent]
permission_mode = "auto-review"

visible_commentary = true

[subagents]
max_concurrent = 3
max_depth = 1
max_per_turn = 3
writer_policy = "single-lease"

[tools]
activation_limit = 10
inline_output_bytes = 65536
inline_output_lines = 200

[permissions]
project_write = "auto"
shell = "safe-auto"
network = "ask"
destructive = "ask"
credentials = "deny"
external_side_effect = "ask"

[sandbox]
level = "workspace"
network_for_shell = "ask"

[sessions]
retain = true
artifact_retention_days = 30
auto_snapshot_events = 100

[privacy]
telemetry = false
crash_reports = "ask"
provider_store = false

[updates]
channel = "stable"
check = true
interval_hours = 24
`;

describe("TOML reader (§21.4)", () => {
  test("parses the PRD example config without issues", () => {
    const parsed = parseToml(EXAMPLE_CONFIG);
    expect(parsed.issues).toEqual([]);
    expect(parsed.values["ui.theme"]).toBe("capybara-dark");
    expect(parsed.values["model.soft_context_tokens"]).toBe(96000);
    expect(parsed.values["agent.visible_commentary"]).toBe(true);
    expect(parsed.values["privacy.telemetry"]).toBe(false);
  });

  test("normalizes snake_case to the internal camelCase paths", () => {
    const normalized = normalizeConfigKeys(parseToml(EXAMPLE_CONFIG).values);
    expect(normalized["model.softContextTokens"]).toBe(96000);
    expect(normalized["permissions.externalSideEffect"]).toBe("ask");
    expect(normalized["ui.statusDensity"]).toBe("auto");
  });

  test("parses arrays, strips comments, and handles quoted keys", () => {
    const parsed = parseToml(`
      # a comment
      [mcp.servers.local_docs]
      transport = "stdio"   # trailing comment
      command = "npx"
      args = ["-y", "@example/docs-mcp"]
      env = ["DOCS_TOKEN"]
    `);
    expect(parsed.issues).toEqual([]);
    expect(parsed.values["mcp.servers.local_docs.args"]).toEqual(["-y", "@example/docs-mcp"]);
    expect(parsed.values["mcp.servers.local_docs.transport"]).toBe("stdio");
  });

  test("maps mcp.servers.* onto mcpServers.*", () => {
    const normalized = normalizeConfigKeys(
      parseToml(`
        [mcp.servers.github]
        transport = "streamable_http"
        url = "https://mcp.example.com/mcp"
        auth = "oauth"
      `).values,
    );
    expect(normalized["mcpServers.github.transport"]).toBe("streamable_http");
    expect(normalized["mcpServers.github.url"]).toBe("https://mcp.example.com/mcp");
  });

  test("maps lsp.servers.* onto configurable language-server definitions", () => {
    const normalized = normalizeConfigKeys(
      parseToml(`
        [lsp.servers.rust]
        command = "rust-analyzer"
        args = []
        extensions = [".rs"]
        language_id = "rust"
        enabled = true
        timeout_ms = 9000
      `).values,
    );
    expect(normalized["lspServers.rust.command"]).toBe("rust-analyzer");
    expect(normalized["lspServers.rust.extensions"]).toEqual([".rs"]);
    expect(normalized["lspServers.rust.languageId"]).toBe("rust");
    expect(normalized["lspServers.rust.timeoutMs"]).toBe(9000);
  });

  test("does not treat a '#' inside a string as a comment", () => {
    const parsed = parseToml(`[ui]\ntheme = "dark#not-a-comment"`);
    expect(parsed.values["ui.theme"]).toBe("dark#not-a-comment");
  });

  test("reports malformed lines with line numbers", () => {
    const parsed = parseToml("[ui]\nthis is not an assignment\ntheme = \"ok\"");
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0]?.line).toBe(2);
    expect(parsed.values["ui.theme"]).toBe("ok");
  });

  test("reports unterminated strings", () => {
    const parsed = parseToml('[ui]\ntheme = "unterminated');
    expect(parsed.issues.some((i) => i.message.includes("unterminated"))).toBe(true);
  });

  test("supports array-of-tables for approval rules (§13.7)", () => {
    const parsed = parseToml(`
      [[allow]]
      tool = "process.run"
      program = "pnpm"
      args_prefix = ["test"]

      [[allow]]
      tool = "fs.read"
    `);
    expect(parsed.values["allow.0.program"]).toBe("pnpm");
    expect(parsed.values["allow.0.args_prefix"]).toEqual(["test"]);
    expect(parsed.values["allow.1.tool"]).toBe("fs.read");
  });

  test("rejects unsupported inline tables rather than misreading them", () => {
    const parsed = parseToml("[x]\ny = { a = 1 }");
    expect(parsed.issues.some((i) => i.message.includes("inline tables"))).toBe(true);
  });
});

describe("defaults (§21.4)", () => {
  test("match the documented values", () => {
    const config = defaultConfig();
    expect(config.ui.mouse).toBe(true);
    expect(config.model.default).toBe("gpt-5.6-sol");
    expect(config.model.reasoningEffort).toBe("medium");
    expect(config.model.reasoning.summary).toBe("auto");
    expect(config.model.softContextTokens).toBe(96_000);
    expect(config.model.maxOutputTokens).toBe(32_000);
    // Security review interim default: execution asks rather than assumes until
    // per-process capability leases exist; auto/auto-review stay opt-in.
    expect(config.agent.permissionMode).toBe("ask");

    expect(config.subagents.maxConcurrent).toBe(3);
    expect(config.subagents.maxDepth).toBe(2);
    expect(config.subagents.writerPolicy).toBe("worktree-lease");
    expect("maxPerTurn" in config.subagents).toBe(false);
    expect(config.tools.activationLimit).toBe(10);
    // §23.5 / D-014: telemetry is off by default.
    expect(config.privacy.telemetry).toBe(false);
    // §10.6: store:false keeps session ownership local.
    expect(config.privacy.providerStore).toBe(false);
    // Service catalogs come from the auto-generated global TOML, not hidden defaults.
    expect(config.mcpServers).toEqual({});
    expect(config.lspServers).toEqual({});
    expect(config.skills).toEqual({
      enabled: true,
      paths: [],
      compatOpencode: true,
      compatAgents: true,
      compatClaude: true,
      legacyPaths: true,
      autoReload: false,
      maxRoots: 64,
      maxCandidates: 512,
      maxDepth: 8,
      scanTimeoutMs: 1_500,
      builtin: { enabled: true, disabled: [] },
    });
  });

  test("include every §10.3 model profile", () => {
    const profiles = defaultConfig().model.profiles;
    for (const name of ["auto", "fast", "balanced", "deep", "review", "economy"]) {
      expect(profiles[name]).toBeDefined();
    }
    expect(profiles.fast?.model).toBe("gpt-5.6-terra");
    expect(profiles.economy?.model).toBe("gpt-5.6-luna");
    expect(profiles.review?.reasoningMode).toBe("pro");
  });

  test("default to chat-first adaptive context policies", () => {
    const config = defaultConfig();
    expect(config.ui.finalAnswer).toEqual({ style: "chat", evidence: "hidden", attentionDetails: false });
    expect(config.model.context.compactionPolicy).toBe("adaptive");
    expect(config.model.context.providerCompactionMode).toBe("auto");
    expect(config.model.context.emergencyRatio).toBe(0.9);
  });
});

describe("Skills discovery configuration", () => {
  test("round-trips paths, builtin exclusions, compatibility flags, and scan budgets from TOML", () => {
    const values = normalizeConfigKeys(parseToml(`
      [skills]
      paths = ["~/shared", "./team"]
      compat_opencode = false
      max_candidates = 99
      max_depth = 4
      scan_timeout_ms = 750

      [skills.builtin]
      disabled = ["code-review", "release-check"]
    `).values);
    const merged = mergeConfig([{ source: "user", values }]);
    expect(merged.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(merged.config.skills.paths).toEqual(["~/shared", "./team"]);
    expect(merged.config.skills.compatOpencode).toBe(false);
    expect(merged.config.skills.maxCandidates).toBe(99);
    expect(merged.config.skills.maxDepth).toBe(4);
    expect(merged.config.skills.scanTimeoutMs).toBe(750);
    expect(merged.config.skills.builtin.disabled).toEqual(["code-review", "release-check"]);
  });

  test("rejects unsafe array element types and out-of-range scan budgets", () => {
    const merged = mergeConfig([{
      source: "user",
      values: {
        "skills.paths": ["ok", 7],
        "skills.maxRoots": 0,
        "skills.maxDepth": 33,
        "skills.scanTimeoutMs": 60_001,
      },
    }]);
    for (const path of ["skills.paths", "skills.maxRoots", "skills.maxDepth", "skills.scanTimeoutMs"]) {
      expect(merged.issues.some((issue) => issue.path === path && issue.severity === "error")).toBe(true);
    }
  });
});

describe("CLI config paths", () => {
  test("normalizes documented snake_case paths", () => {
    expect(normalizeConfigPath("model.reasoning_effort")).toBe("model.reasoningEffort");
    expect(normalizeConfigPath("model.reasoning.summary")).toBe("model.reasoning.summary");
    expect(normalizeConfigPath("model.max_output_tokens")).toBe("model.maxOutputTokens");
  });
});

describe("completion and compaction configuration", () => {
  test("accepts providerCompaction = auto as a compatibility mode", () => {
    const merged = mergeConfig([{
      source: "user",
      values: {
        "ui.finalAnswer.style": "report",
        "model.context.compactionPolicy": "legacy",
        "model.context.providerCompaction": "auto",
      },
    }]);
    expect(merged.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(merged.config.ui.finalAnswer.style).toBe("report");
    expect(merged.config.model.context.compactionPolicy).toBe("legacy");
    expect(merged.config.model.context.providerCompactionMode).toBe("auto");
  });
});

describe("provider reasoning summary configuration", () => {
  test("keeps provider generation independent from TUI disclosure", () => {
    const merged = mergeConfig([
      {
        source: "user",
        values: {
          "ui.thinkingVisibility": "hidden",
          "model.reasoning.summary": "none",
        },
      },
    ]);

    expect(merged.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(merged.config.ui.thinkingVisibility).toBe("hidden");
    expect(merged.config.model.reasoning.summary).toBe("none");
  });

  test("rejects an unsupported provider reasoning-summary policy", () => {
    const merged = mergeConfig([
      { source: "user", values: { "model.reasoning.summary": "always" } },
    ]);
    expect(merged.issues.some((issue) => issue.path === "model.reasoning.summary" && issue.severity === "error")).toBe(true);
  });
});
describe("precedence (§21.2)", () => {
  test("later layers win and provenance is recorded", () => {
    const merged = mergeConfig([
      { source: "user", values: { "model.default": "gpt-5.6" } },
      { source: "project", values: { "model.default": "gpt-5.6-terra" } },
      { source: "environment", values: { "model.default": "gpt-5.6-luna" } },
      { source: "cli", values: { "model.default": "gpt-5.6" } },
    ]);
    expect(merged.config.model.default).toBe("gpt-5.6");
    expect(merged.provenance["model.default"]).toBe("cli");
  });

  test("session override beats every other layer", () => {
    const merged = mergeConfig([
      { source: "cli", values: { "agent.permissionMode": "plan" } },
      { source: "session", values: { "agent.permissionMode": "auto" } },
    ]);
    expect(merged.config.agent.permissionMode).toBe("auto");
    expect(merged.provenance["agent.permissionMode"]).toBe("session");
  });

  test("merge is deterministic (§25.4)", () => {
    const layers = [
      { source: "user" as const, values: { "ui.theme": "a", "agent.toolGraph.maxParallelReads": 10 } },
      { source: "project" as const, values: { "ui.theme": "b" } },
    ];
    const first = mergeConfig(layers);
    const second = mergeConfig(layers);
    expect(first.config).toEqual(second.config);
    expect(first.provenance).toEqual(second.provenance);
  });
});

describe("trust-gated project config", () => {
  test("project TOML is ignored while untrusted and applied with provenance after trust", () => {
    const projectToml = "[agent.tool_graph]\nmax_parallel_reads = 2\n";
    const untrusted = loadConfig({ projectToml, projectTrusted: false, env: {} });
    expect(untrusted.config.agent.toolGraph.maxParallelReads).not.toBe(2);
    expect(untrusted.provenance["agent.toolGraph.maxParallelReads"]).toBeUndefined();
    expect(untrusted.issues.some((issue) => issue.source === "project" && issue.path === "project"))
      .toBe(true);

    const trusted = loadConfig({ projectToml, projectTrusted: true, env: {} });
    expect(trusted.config.agent.toolGraph.maxParallelReads).toBe(2);
    expect(trusted.provenance["agent.toolGraph.maxParallelReads"]).toBe("project");
  });

  test("project-local values override shared project values only after trust", () => {
    const result = loadConfig({
      projectToml: "[agent.tool_graph]\nmax_parallel_reads = 2\n",
      projectLocalToml: "[agent.tool_graph]\nmax_parallel_reads = 3\n",
      projectTrusted: true,
      env: {},
    });
    expect(result.config.agent.toolGraph.maxParallelReads).toBe(3);
    expect(result.provenance["agent.toolGraph.maxParallelReads"]).toBe("project-local");
  });

  test("project config may not set a credential field", () => {
    const merged = mergeConfig([
      { source: "project", values: { "auth.apiKey": "sk-should-be-rejected" } },
    ]);
    const issue = merged.issues.find((i) => i.path === "auth.apiKey");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("credentials come from the user keychain");
  });

  test("project config may not bind host environment variables into an MCP server", () => {
    for (const source of ["project", "project-local"] as const) {
      const merged = mergeConfig([
        {
          source,
          values: {
            "mcpServers.local.transport": "stdio",
            "mcpServers.local.command": "local-mcp",
            "mcpServers.local.env": ["OPAQUE_HOST_SECRET"],
          },
        },
      ]);
      expect(merged.config.mcpServers.local?.env).toBeUndefined();
      expect(merged.issues.some(
        (issue) => issue.path === "mcpServers.local.env" && issue.severity === "error",
      )).toBe(true);
    }
  });

  test("project config cannot replace personal model choices or user LSP servers", () => {
    const merged = mergeConfig([
      {
        source: "user",
        values: {
          "model.default": "gpt-5.6-sol",
          "model.reasoningEffort": "high",
          "lspServers.typescript.command": "user-tsserver",
        },
      },
      {
        source: "project",
        values: {
          "model.default": "gpt-5.6-luna",
          "model.reasoningEffort": "low",
          "lspServers.typescript.command": "project-tsserver",
        },
      },
    ]);
    expect(merged.config.model.default).toBe("gpt-5.6-sol");
    expect(merged.config.model.reasoningEffort).toBe("high");
    expect(merged.config.lspServers.typescript?.command).toBe("user-tsserver");
    expect(merged.issues.filter((issue) => issue.source === "project" && issue.severity === "error"))
      .toHaveLength(3);
  });

  test("user MCP config may bind host environment variable names", () => {
    const merged = mergeConfig([
      { source: "user", values: { "mcpServers.local.env": ["USER_OWNED_SECRET"] } },
    ]);
    expect(merged.config.mcpServers.local?.env).toEqual(["USER_OWNED_SECRET"]);
    expect(merged.issues.filter((issue) => issue.severity === "error")).toEqual([]);
  });

  test("the same key from the user layer is not credential-blocked", () => {
    // The restriction is about *project* provenance, not the key alone.
    const merged = mergeConfig([{ source: "user", values: { "ui.theme": "x" } }]);
    expect(merged.issues.filter((i) => i.severity === "error")).toEqual([]);
  });
});

describe("monotonic project policy (P0-02)", () => {
  test("a project cannot weaken user network=deny to allow", () => {
    const merged = mergeConfig([
      { source: "user", values: { "permissions.network": "deny" } },
      { source: "project", values: { "permissions.network": "allow" } },
    ]);
    expect(merged.config.permissions.network).toBe("deny");
    const issue = merged.issues.find((i) => i.path === "permissions.network");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("may not weaken");
  });

  test("a project can still tighten a user permission", () => {
    const merged = mergeConfig([
      { source: "user", values: { "permissions.network": "allow" } },
      { source: "project", values: { "permissions.network": "deny" } },
    ]);
    expect(merged.config.permissions.network).toBe("deny");
    expect(merged.issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  test("a project cannot lower the sandbox level", () => {
    const merged = mergeConfig([
      { source: "user", values: { "sandbox.level": "strict" } },
      { source: "project", values: { "sandbox.level": "none" } },
    ]);
    expect(merged.config.sandbox.level).toBe("strict");
    expect(
      merged.issues.some((i) => i.path === "sandbox.level" && i.severity === "error"),
    ).toBe(true);
  });

  test("a project cannot widen permission mode toward auto", () => {
    const merged = mergeConfig([
      { source: "user", values: { "agent.permissionMode": "ask" } },
      { source: "project", values: { "agent.permissionMode": "auto" } },
    ]);
    expect(merged.config.agent.permissionMode).toBe("ask");
    expect(
      merged.issues.some((i) => i.path === "agent.permissionMode" && i.severity === "error"),
    ).toBe(true);
  });

  test("a project cannot enable telemetry the user left off", () => {
    const merged = mergeConfig([
      { source: "project", values: { "privacy.telemetry": true } },
    ]);
    expect(merged.config.privacy.telemetry).toBe(false);
    expect(
      merged.issues.some((i) => i.path === "privacy.telemetry" && i.severity === "error"),
    ).toBe(true);
  });

  test("updates and hosted-provider toggles are user-only", () => {
    const merged = mergeConfig([
      { source: "project", values: { "updates.channel": "nightly" } },
      {
        source: "project",
        values: { "provider.openai.native.allowHostedShell": true },
      },
    ]);
    expect(merged.config.updates.channel).toBe("stable");
    expect(merged.config.provider.openai.native.allowHostedShell).toBe(false);
    expect(
      merged.issues.filter((i) => i.severity === "error" && i.message.includes("user-only")),
    ).toHaveLength(2);
  });

  test("a project cannot override a user-defined MCP server", () => {
    const merged = mergeConfig([
      {
        source: "user",
        values: { "mcpServers.github.transport": "stdio", "mcpServers.github.command": "gh-mcp" },
      },
      { source: "project", values: { "mcpServers.github.command": "evil-mcp" } },
    ]);
    expect(merged.config.mcpServers.github?.command).toBe("gh-mcp");
    expect(
      merged.issues.some(
        (i) => i.severity === "error" && i.message.includes("user-defined MCP server"),
      ),
    ).toBe(true);
  });

  test("a project may still define its own new MCP server", () => {
    const merged = mergeConfig([
      { source: "project", values: { "mcpServers.local.transport": "stdio" } },
    ]);
    expect(merged.config.mcpServers.local?.transport).toBe("stdio");
    expect(merged.issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  test("semantic issues are attributed to the layer that set the value", () => {
    const merged = mergeConfig([
      { source: "project", values: { "subagents.maxDepth": 4 } },
    ]);
    const issue = merged.issues.find((i) => i.path === "subagents.maxDepth");
    expect(issue?.source).toBe("project");
  });
});

describe("validation (§21.7)", () => {
  test("unknown keys warn but do not fail", () => {
    const merged = mergeConfig([{ source: "user", values: { "ui.nonexistent": 1 } }]);
    const issue = merged.issues.find((i) => i.path === "ui.nonexistent");
    expect(issue?.severity).toBe("warning");
    expect(issue?.message).toContain("unknown configuration key");
  });

  test("enum violations are errors", () => {
    const merged = mergeConfig([
      { source: "user", values: { "agent.permissionMode": "dangerously-skip-permissions" } },
    ]);
    const issue = merged.issues.find((i) => i.path === "agent.permissionMode");
    expect(issue?.severity).toBe("error");
    // §13.1: full / dangerously-skip-permissions is not a public option.
    expect(merged.config.agent.permissionMode).toBe("ask");
  });

  test("type mismatches are errors and leave the default", () => {
    const merged = mergeConfig([{
      source: "user",
      values: { "agent.toolGraph.maxParallelReads": "many" },
    }]);
    const issue = merged.issues.find((i) => i.path === "agent.toolGraph.maxParallelReads");
    expect(issue?.severity).toBe("error");
    expect(merged.config.agent.toolGraph.maxParallelReads).toBe(8);
  });

  test("removed root turn limits warn and are ignored", () => {
    const merged = mergeConfig([{
      source: "user",
      values: {
        "agent.maxSteps": 4,
        "agent.maxToolCalls": 8,
        "agent.maxWallTimeMinutes": 1,
      },
    }]);
    expect(merged.issues).toHaveLength(3);
    expect(merged.issues.every((issue) =>
      issue.severity === "warning" && issue.message.includes("was removed")
    )).toBe(true);
    expect("maxSteps" in merged.config.agent).toBe(false);
    expect("maxToolCalls" in merged.config.agent).toBe(false);
    expect("maxWallTimeMinutes" in merged.config.agent).toBe(false);
  });

  test("deprecated keys migrate with a message", () => {
    const merged = mergeConfig([{ source: "user", values: { "agent.mode": "ask" } }]);
    expect(merged.issues.some((i) => i.message.includes("deprecated"))).toBe(true);
    expect(merged.config.agent.permissionMode).toBe("ask");
  });

  test("delegation depth above the hard maximum of 3 is rejected", () => {
    const merged = mergeConfig([{ source: "user", values: { "subagents.maxDepth": 4 } }]);
    expect(
      merged.issues.some((i) => i.path === "subagents.maxDepth" && i.severity === "error"),
    ).toBe(true);
  });

  test("conflicting permissions produce a warning", () => {
    const merged = mergeConfig([
      { source: "user", values: { "agent.permissionMode": "plan", "permissions.projectWrite": "auto" } },
    ]);
    expect(
      merged.issues.some(
        (i) => i.path === "permissions.projectWrite" && i.severity === "warning",
      ),
    ).toBe(true);
  });

  test("an undefined model profile is an error", () => {
    const merged = mergeConfig([{ source: "user", values: { "model.profile": "nonexistent" } }]);
    expect(merged.issues.some((i) => i.path === "model.profile" && i.severity === "error")).toBe(
      true,
    );
  });

  test("manual model selections use the concrete model fields without a named profile", () => {
    const merged = mergeConfig([{
      source: "user",
      values: {
        "model.profile": "manual",
        "model.default": "gpt-5.6-sol",
        "model.reasoningEffort": "low",
      },
    }]);

    expect(merged.issues.some((i) => i.path === "model.profile" && i.severity === "error")).toBe(
      false,
    );
    expect(merged.config.model.profile).toBe("manual");
    expect(merged.config.model.default).toBe("gpt-5.6-sol");
    expect(merged.config.model.reasoningEffort).toBe("low");
  });

  test("project maxOutputTokens is not mistaken for a credential token", () => {
    const merged = mergeConfig([
      { source: "project", values: { "model.maxOutputTokens": 13_000 } },
    ]);
    expect(merged.config.model.maxOutputTokens).toBe(13_000);
    expect(merged.issues.some((issue) => issue.path === "model.maxOutputTokens" && issue.severity === "error")).toBe(false);
  });

  test("rejects prototype-polluting dotted paths", () => {
    const merged = mergeConfig([
      {
        source: "user",
        values: {
          "__proto__.polluted": true,
          "mcpServers.constructor.command": "bad",
        },
      },
    ]);
    expect(merged.issues.filter((issue) => issue.severity === "error")).toHaveLength(2);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(readPath({ inherited: "no" }, "__proto__.inherited")).toBeUndefined();
    expect(() => writePath({}, "constructor.prototype.polluted", true)).toThrow();
  });

  test("validates arrays and dynamic map entries", () => {
    const merged = mergeConfig([
      {
        source: "user",
        values: {
          "model.context.bands": ["large"],
          "mcpServers.local.args": "--unsafe",
          "mcpServers.local.unknown": true,
          "lspServers.rust.args": "--unsafe",
          "lspServers.rust.unknown": true,
          "model.profiles.fast.reasoningEffort": 42,
          "keymap.submit": 7,
        },
      },
    ]);
    expect(merged.issues.filter((issue) => issue.severity === "error")).toHaveLength(7);
    expect(merged.config.mcpServers.local).toBeUndefined();
    expect(merged.config.lspServers.rust).toBeUndefined();
  });

  test("requires complete LSP definitions", () => {
    const merged = mergeConfig([
      { source: "user", values: { "lspServers.rust.command": "rust-analyzer" } },
    ]);
    expect(merged.issues).toContainEqual(
      expect.objectContaining({
        severity: "error",
        path: "lspServers.rust.languageId",
      }),
    );
    expect(merged.issues).toContainEqual(
      expect.objectContaining({
        severity: "error",
        path: "lspServers.rust.extensions",
      }),
    );
  });

  test("does not let a default preset override an explicit ask mode", () => {
    const merged = mergeConfig([
      { source: "user", values: { "agent.permissionMode": "ask" } },
    ]);
    expect(merged.config.permissions.preset).toBeUndefined();
    expect(merged.issues.some((issue) => issue.path === "permissions.preset")).toBe(false);
  });

  test("rejects conflicting explicit permission surfaces", () => {
    const merged = mergeConfig([
      {
        source: "user",
        values: {
          "agent.permissionMode": "ask",
          "permissions.preset": "auto",
        },
      },
    ]);
    expect(merged.issues.some((issue) => issue.path === "permissions.preset" && issue.severity === "error")).toBe(true);
  });

  test("absurd budgets are rejected", () => {
    expect(
      mergeConfig([{ source: "user", values: { "model.softContextTokens": 10 } }]).issues.some(
        (i) => i.severity === "error",
      ),
    ).toBe(true);
    expect(
      mergeConfig([{ source: "user", values: { "model.maxOutputTokens": 1 } }]).issues.some(
        (i) => i.severity === "error",
      ),
    ).toBe(true);
  });
});

describe("config key status (P1-04)", () => {
  test("wired, experimental, and deprecated keys are classified", () => {
    expect(configKeyInfo("model.default")?.status).toBe("wired");
    expect(configKeyInfo("sandbox.level")?.status).toBe("wired");
    expect(configKeyInfo("ui.theme")?.status).toBe("wired");
    expect(configKeyInfo("ui.mouse")?.status).toBe("wired");
    expect(configKeyInfo("privacy.telemetry")?.status).toBe("experimental");
    expect(configKeyInfo("tools.activationLimit")?.status).toBe("experimental");
    // Longest prefix wins: a leaf overrides its section.
    expect(configKeyInfo("model.router.cheapTier")?.status).toBe("wired");
    expect(configKeyInfo("model.router.strategy")?.status).toBe("wired");
    expect(configKeyInfo("provider.openai.native.programmaticToolCalling")?.status).toBe("wired");
    expect(configKeyInfo("provider.openai.native.maxProgramToolCalls")?.status).toBe("wired");
    // §5.6's hosted lane now has a real consumer, so the catch-all no longer
    // describes these two keys — setting them changes what runs.
    expect(configKeyInfo("provider.openai.native.hostedMultiAgent")?.status).toBe("wired");
    expect(configKeyInfo("provider.openai.native.hostedMultiAgent")?.consumer).toContain("HostedScoutCoordinator");
    expect(configKeyInfo("provider.openai.native.maxHostedAgents")?.status).toBe("wired");
    // The section catch-all still covers the keys that remain digest-only.
    expect(configKeyInfo("provider.openai.native.maxProgramParallelCalls")?.status).toBe("wired");
    // §5.4's remaining per-program budgets. Each is only "wired" because the lane
    // coordinator reads it; §5.18 counts a key nothing consumes as an overclaim,
    // so the consumer string has to name the gate, not the section.
    for (const key of [
      "provider.openai.native.maxProgramWallTimeMs",
      "provider.openai.native.maxProgramOutputBytes",
      "provider.openai.native.maxProgramIntermediateBytes",
      "provider.openai.native.maxProgramRetries",
    ] as const) {
      expect(configKeyInfo(key)?.status).toBe("wired");
      expect(configKeyInfo(key)?.consumer).toContain("ProgrammaticToolLane");
    }
  });

  test("the per-program budgets default to the lane policy they configure", () => {
    // These are DEFAULT_PROGRAM_POLICY's values, restated rather than imported:
    // config-schema is below provider-openai, and depending upwards to assert a
    // default would invert that. A drift between the two changes the shipped
    // budget silently, which is exactly what makes them worth pinning here.
    const native = defaultConfig().provider.openai.native;
    expect(native.maxProgramWallTimeMs).toBe(30_000);
    expect(native.maxProgramOutputBytes).toBe(1_048_576);
    expect(native.maxProgramIntermediateBytes).toBe(4_194_304);
    expect(native.maxProgramRetries).toBe(1);
  });

  test("a wired key names its consumer", () => {
    expect(configKeyInfo("sandbox.level")?.consumer).toContain("runtime");
    expect(configKeyInfo("subagents.maxConcurrent")?.consumer).toContain("scheduler");
    expect(configKeyInfo("subagents.maxPerTurn")?.status).toBe("deprecated");
  });

  test("classifies Skills discovery keys without overclaiming the reserved watcher", () => {
    expect(configKeyInfo("skills.paths")?.status).toBe("wired");
    expect(configKeyInfo("skills.maxCandidates")?.consumer).toContain("SkillDiscoveryService");
    expect(configKeyInfo("skills.autoReload")?.status).toBe("experimental");
  });

  test("setting an experimental key warns that it is not applied", () => {
    const merged = mergeConfig([{ source: "user", values: { "tools.activationLimit": 4 } }]);
    const issue = merged.issues.find((i) => i.path === "tools.activationLimit");
    expect(issue?.severity).toBe("warning");
    expect(issue?.message).toContain("not applied");
    // The value is still stored; it just does nothing.
    expect(merged.config.tools.activationLimit).toBe(4);
  });

  test("setting a wired key produces no status warning", () => {
    const merged = mergeConfig([{ source: "user", values: { "model.default": "gpt-5.6-terra" } }]);
    expect(merged.issues.some((i) => i.path === "model.default")).toBe(false);
  });

  test("removed subagents.maxPerTurn warns and is ignored", () => {
    const merged = mergeConfig([{ source: "user", values: { "subagents.maxPerTurn": 3 } }]);
    const issue = merged.issues.find((i) => i.path === "subagents.maxPerTurn");
    expect(issue?.severity).toBe("warning");
    expect(issue?.message).toContain("was removed");
    expect("maxPerTurn" in merged.config.subagents).toBe(false);
  });
});

describe("environment layer (§21.6)", () => {
  test("maps documented variables", () => {
    const layer = environmentLayer({
      CBC_MODEL: "gpt-5.6-terra",
      CBC_REASONING_EFFORT: "high",
      CBC_PERMISSION_MODE: "plan",
    });
    expect(layer["model.default"]).toBe("gpt-5.6-terra");
    expect(layer["model.reasoningEffort"]).toBe("high");
    expect(layer["agent.permissionMode"]).toBe("plan");
  });

  test("NO_COLOR forces color off (§6.20, AC-45)", () => {
    expect(environmentLayer({ NO_COLOR: "1" })["ui.color"]).toBe("never");
    expect(environmentLayer({})["ui.color"]).toBeUndefined();
  });

  test("CBC_NO_UPDATE_CHECK disables the update check", () => {
    expect(environmentLayer({ CBC_NO_UPDATE_CHECK: "1" })["updates.check"]).toBe(false);
  });

  test("OPENAI_API_KEY is never copied into config (§21.6)", () => {
    const layer = environmentLayer({ OPENAI_API_KEY: "sk-must-not-appear" });
    expect(JSON.stringify(layer)).not.toContain("sk-must-not-appear");
    expect(Object.keys(layer)).toHaveLength(0);
  });

  test("empty variables are ignored", () => {
    expect(Object.keys(environmentLayer({ CBC_MODEL: "" }))).toHaveLength(0);
  });
});

describe("paths (§21.1)", () => {
  test("uses XDG-style Unix defaults", () => {
    const paths = resolvePaths({}, "/home/me", "linux");
    expect(paths.config).toBe("/home/me/.config/capybara/config.toml");
    expect(paths.data).toBe("/home/me/.local/share/capybara");
    expect(paths.cache).toBe("/home/me/.cache/capybara");
    expect(paths.logs).toBe("/home/me/.local/state/capybara/logs");
  });

  test("honours CAPYBARA_HOME", () => {
    const paths = resolvePaths({ CAPYBARA_HOME: "/opt/cbc" }, "/home/me", "linux");
    expect(paths.config).toBe("/opt/cbc/config.toml");
    expect(paths.data).toBe("/opt/cbc/data");
  });

  test("honours individual overrides", () => {
    const paths = resolvePaths(
      { CAPYBARA_CONFIG: "/etc/cbc.toml", CAPYBARA_DATA_DIR: "/var/cbc" },
      "/home/me",
      "linux",
    );
    expect(paths.config).toBe("/etc/cbc.toml");
    expect(paths.data).toBe("/var/cbc");
  });

  test("uses a platform-appropriate Windows location (§18.14)", () => {
    const paths = resolvePaths({ LOCALAPPDATA: "C:/Users/me/AppData/Local" }, "C:/Users/me", "win32");
    expect(paths.data).toContain("capybara-code");
    expect(paths.data).toContain("AppData/Local");
  });

  test("respects XDG_CONFIG_HOME", () => {
    const paths = resolvePaths({ XDG_CONFIG_HOME: "/custom/config" }, "/home/me", "linux");
    expect(paths.config).toBe("/custom/config/capybara/config.toml");
  });
});

describe("full load", () => {
  test("applies all layers in order", () => {
    const result = loadConfig({
      userToml: '[model]\ndefault = "gpt-5.6"\nreasoning_effort = "low"\n',
      projectToml: '[agent]\npermission_mode = "ask"\n',
      projectTrusted: true,
      env: { CBC_REASONING_EFFORT: "high" },
      cliOverrides: { "model.default": "gpt-5.6-terra" },
    });
    expect(result.config.model.default).toBe("gpt-5.6-terra"); // CLI
    expect(result.config.model.reasoningEffort).toBe("high"); // env beats user
    expect(result.config.agent.permissionMode).toBe("ask"); // trusted project
    expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  test("the example config produces no errors", () => {
    const result = loadConfig({
      userToml: EXAMPLE_CONFIG,
      projectTrusted: true,
      env: {},
    });
    expect(result.tomlIssues).toEqual([]);
    expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  test("surfaces TOML issues with their source", () => {
    const result = loadConfig({
      userToml: "[ui]\nbroken line here\n",
      projectTrusted: true,
      env: {},
    });
    expect(result.tomlIssues[0]?.source).toBe("user");
  });

  test("P0-13: user declarative permissions.rules remain available", () => {
    const result = loadConfig({
      userToml: [
        "[[permissions.rules]]",
        'tool = "process.run"',
        'decision = "allow"',
        'risk = "R1"',
        'program = "ls"',
        "",
        "[[permissions.rules]]",
        'tool = "fs.delete"',
        'decision = "deny"',
        'risk = "R4"',
      ].join("\n"),
      projectTrusted: true,
      env: {},
    });
    expect(result.tomlIssues).toEqual([]);
    expect(result.config.permissions.rules).toHaveLength(2);
    expect(result.config.permissions.rules[0]).toMatchObject({ decision: "allow" });
    expect(result.config.permissions.rules[1]).toMatchObject({ decision: "deny" });
  });

  test("project allow rules are rejected rather than activated", () => {
    const result = loadConfig({
      projectToml: [
        "[[permissions.rules]]",
        'tool = "process.run"',
        'decision = "allow"',
        'risk = "R1"',
      ].join("\n"),
      projectTrusted: true,
      env: {},
    });
    expect(result.config.permissions.rules).toEqual([]);
    expect(result.issues.some((issue) =>
      issue.path === "permissions.rules"
      && issue.source === "project"
      && issue.severity === "error"
    )).toBe(true);
  });

  test("P0-02: projectWrite cannot weaken a user plan", () => {
    const merged = mergeConfig([
      { source: "user", values: { "permissions.projectWrite": "plan" } },
      { source: "project", values: { "permissions.projectWrite": "auto" } },
    ]);
    expect(merged.config.permissions.projectWrite).toBe("plan");
    expect(
      merged.issues.some(
        (issue) => issue.path === "permissions.projectWrite" && issue.severity === "error",
      ),
    ).toBe(true);
  });

  test("P0-13: permissions.rules default to an empty list", () => {
    const result = loadConfig({ projectTrusted: true, env: {} });
    expect(result.config.permissions.rules).toEqual([]);
  });
});


describe("provider cache TTL normalization (Context P0)", () => {
  test("unsupported configured TTL is warned and normalized to 30 minutes", () => {
    const loaded = loadConfig({
      projectTrusted: true,
      env: {},
      userToml: "[model.cache]\nttl_minutes = 90\n",
    });
    expect(loaded.config.model.cache.ttlMinutes).toBe(30);
    expect(loaded.issues.some((issue) =>
      issue.path === "model.cache.ttlMinutes" && issue.severity === "warning"
    )).toBe(true);
  });
});

describe("token saving (§token-saving)", () => {
  test("defaults to off so existing behaviour is unchanged", () => {
    const loaded = loadConfig({ projectTrusted: true, env: {} });
    expect(loaded.config.agent.tokenSaving).toBe("off");
  });

  test("accepts the four intensity levels from user config", () => {
    for (const level of ["off", "light", "balanced", "strong"] as const) {
      const loaded = loadConfig({
        projectTrusted: true,
        env: {},
        userToml: `[agent]\ntoken_saving = "${level}"\n`,
      });
      expect(loaded.config.agent.tokenSaving).toBe(level);
      expect(loaded.issues.filter((i) => i.severity === "error")).toHaveLength(0);
    }
  });

  test("rejects an unknown intensity", () => {
    const loaded = loadConfig({
      projectTrusted: true,
      env: {},
      userToml: `[agent]\ntoken_saving = "ultra"\n`,
    });
    expect(loaded.config.agent.tokenSaving).toBe("off");
    expect(
      loaded.issues.some((i) => i.severity === "error" && i.path === "agent.tokenSaving"),
    ).toBe(true);
  });

  test("normalizes snake_case token_saving to the camelCase key", () => {
    const loaded = loadConfig({
      projectTrusted: true,
      env: {},
      userToml: `[agent]\ntoken_saving = "strong"\n`,
    });
    expect(loaded.provenance["agent.tokenSaving"]).toBe("user");
  });

  test("a project cannot force the user's quality policy down", () => {
    const merged = mergeConfig([
      { source: "project", values: { "agent.tokenSaving": "strong" } },
    ]);
    expect(merged.config.agent.tokenSaving).toBe("off");
    expect(
      merged.issues.some((i) => i.severity === "error" && i.message.includes("user-only")),
    ).toBe(true);
  });

  test("the key is registered as wired with a named consumer", () => {
    const info = configKeyInfo("agent.tokenSaving");
    expect(info?.status).toBe("wired");
    expect(info?.consumer).toContain("saving controller");
  });
});

describe("Deep Plan", () => {
  test("defaults to off and accepts the user-owned enum", () => {
    expect(loadConfig({ projectTrusted: true, env: {} }).config.agent.deepPlan).toBe("off");
    for (const mode of ["off", "on"] as const) {
      const loaded = loadConfig({
        projectTrusted: true,
        env: {},
        userToml: `[agent]\ndeep_plan = "${mode}"\n`,
      });
      expect(loaded.config.agent.deepPlan).toBe(mode);
      expect(loaded.provenance["agent.deepPlan"]).toBe("user");
      expect(loaded.issues.filter((issue) => issue.severity === "error")).toHaveLength(0);
    }
  });

  test("rejects invalid values and project overrides", () => {
    const invalid = loadConfig({
      projectTrusted: true,
      env: {},
      userToml: `[agent]\ndeep_plan = "always"\n`,
    });
    expect(invalid.config.agent.deepPlan).toBe("off");
    expect(invalid.issues.some((issue) =>
      issue.path === "agent.deepPlan" && issue.severity === "error"
    )).toBe(true);

    const project = mergeConfig([
      { source: "project", values: { "agent.deepPlan": "on" } },
    ]);
    expect(project.config.agent.deepPlan).toBe("off");
    expect(project.issues.some((issue) =>
      issue.path === "agent.deepPlan" && issue.message.includes("user-only")
    )).toBe(true);
  });

  test("is registered as a wired config key", () => {
    const info = configKeyInfo("agent.deepPlan");
    expect(info?.status).toBe("wired");
    expect(info?.consumer).toContain("Deep Plan");
  });
});

describe("productized OpenAI-first defaults (§6 P1-03, §8.4)", () => {
  test("reasoning continuity accepts the whole §8.4 ladder", () => {
    expect(defaultConfig().model.reasoning.continuity).toBe("adaptive");
    expect(configEnumValues("model.reasoning.continuity")).toEqual([
      "current-turn",
      "all-turns",
      "adaptive",
    ]);

    for (const value of ["current-turn", "all-turns", "adaptive"] as const) {
      const merged = mergeConfig([
        { source: "user", values: { "model.reasoning.continuity": value } },
      ]);
      expect(merged.config.model.reasoning.continuity).toBe(value);
      expect(merged.issues.some((issue) =>
        issue.path === "model.reasoning.continuity" && issue.severity === "error"
      )).toBe(false);
    }

    const rejected = mergeConfig([
      { source: "user", values: { "model.reasoning.continuity": "task-epoch" } },
    ]);
    expect(rejected.issues.some((issue) =>
      issue.path === "model.reasoning.continuity" && issue.severity === "error"
    )).toBe(true);
  });

  test("continuity stays experimental until a consumer clamps the epoch scope", () => {
    expect(configKeyInfo("model.reasoning.continuity")?.status).toBe("experimental");
  });

  test("the §8.4 cache ladder and breakpoint key are accepted", () => {
    const defaults = defaultConfig();
    expect(defaults.model.cache.breakpoint).toBe("stable-prefix");
    expect(defaults.model.cache.ttl).toBe("30m");
    expect(configEnumValues("model.cache.mode")).toEqual([
      "roi",
      "always",
      "implicit",
      "explicit",
      "off",
    ]);

    const merged = mergeConfig([
      { source: "user", values: { "model.cache.mode": "explicit", "model.cache.breakpoint": "stable-prefix" } },
    ]);
    expect(merged.config.model.cache.mode).toBe("explicit");
    expect(merged.issues.some((issue) => issue.severity === "error")).toBe(false);
  });

  test("cache breakpoint and ttl are experimental because nothing reads them", () => {
    // §5.18: a key the schema accepts but no consumer applies is an overclaim,
    // so the two spellings §8.4 asks for say so rather than looking honoured.
    expect(configKeyInfo("model.cache.breakpoint")?.status).toBe("experimental");
    expect(configKeyInfo("model.cache.ttl")?.status).toBe("experimental");
    expect(configKeyInfo("model.cache.mode")?.status).toBe("wired");
  });

  test("the backend profile key is accepted and marked as derived", () => {
    expect(defaultConfig().provider.openai.profile).toBe("auto");
    expect(configEnumValues("provider.openai.profile")).toEqual([
      "auto",
      "api-enhanced",
      "chatgpt-compatible",
    ]);

    const merged = mergeConfig([
      { source: "user", values: { "provider.openai.profile": "chatgpt-compatible" } },
    ]);
    expect(merged.config.provider.openai.profile).toBe("chatgpt-compatible");
    expect(configKeyInfo("provider.openai.profile")?.status).toBe("experimental");

    const rejected = mergeConfig([
      { source: "user", values: { "provider.openai.profile": "azure" } },
    ]);
    expect(rejected.issues.some((issue) =>
      issue.path === "provider.openai.profile" && issue.severity === "error"
    )).toBe(true);
  });
});

describe("action surface gate (§6.5, §6.6)", () => {
  test("the action surface is off by default", () => {
    // §6.6 removes one group at a time with a bench re-run between, so this must
    // never be on without someone asking for it.
    expect(defaultConfig().agent.actionSurface).toEqual([]);
    expect(configKeyInfo("agent.actionSurface")?.status).toBe("wired");
  });

  test("groups are enabled one at a time", () => {
    const merged = mergeConfig([
      { source: "user", values: { "agent.actionSurface": ["change"] } },
    ]);
    expect(merged.config.agent.actionSurface).toEqual(["change"]);
    expect(merged.issues.some((issue) => issue.path === "agent.actionSurface" && issue.severity === "error")).toBe(false);
  });

  test("an unknown group name is an error, not a silently ignored value", () => {
    // A typo that was tolerated would leave the surface off while the operator
    // believed the ablation was running.
    const rejected = mergeConfig([
      { source: "user", values: { "agent.actionSurface": ["change", "mutate"] } },
    ]);
    expect(rejected.issues.some((issue) =>
      issue.path === "agent.actionSurface" && issue.severity === "error"
    )).toBe(true);
    const wrongType = mergeConfig([
      { source: "user", values: { "agent.actionSurface": "change" } },
    ]);
    expect(wrongType.issues.some((issue) => issue.path === "agent.actionSurface")).toBe(true);
  });
});
