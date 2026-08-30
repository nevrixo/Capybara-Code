import { describe, expect, test } from "bun:test";

import { configKeyInfo, defaultConfig, loadConfig, normalizeConfigPath } from "@cbc/config-schema";

import { GLOBAL_CONFIG_TEMPLATE } from "../src/config-template.ts";

describe("global config template", () => {
  test("the first-use template is valid and owns the service catalogs", () => {
    const loaded = loadConfig({ userToml: GLOBAL_CONFIG_TEMPLATE, env: {} });

    expect(loaded.tomlIssues).toEqual([]);
    expect(loaded.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(loaded.config.mcpServers.context7?.url).toBe("https://mcp.context7.com/mcp");
    expect(loaded.config.lspServers.typescript?.command).toBe("typescript-language-server");
    expect(loaded.config.lspServers.python?.command).toBe("pyright-langserver");
  });

  test("§6 P1-03: every commented example is a real key with a legal value", () => {
    // The productized defaults are documented as commented examples, so nothing in
    // the loader checks them — a renamed key or a stale enum value would sit in the
    // first file every user opens, describing settings that no longer exist.
    // Uncommenting the whole template is what turns the documentation into an
    // assertion.
    const uncommented = GLOBAL_CONFIG_TEMPLATE.split(/\r?\n/u)
      .map((line) => {
        const match = /^#\s?(\[[^\]]+\]|[a-z_]+(?:\.[a-z_]+)*\s*=.*)$/u.exec(line.trim());
        return match === null ? line : (match[1] as string);
      })
      .join("\n");
    const loaded = loadConfig({ userToml: uncommented, env: {} });
    expect(loaded.tomlIssues).toEqual([]);
    expect(loaded.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    // The only warnings allowed are the experimental ones, and the template has to
    // say so beside each: recommending a key that is accepted and does nothing,
    // without marking it, is the overclaim §5.18 exists to prevent. Any other
    // warning is the unknown-key path — the drift this test is here to catch.
    for (const issue of loaded.issues.filter((entry) => entry.severity === "warning")) {
      expect(configKeyInfo(issue.path)?.status, issue.path).toBe("experimental");
      expect(GLOBAL_CONFIG_TEMPLATE, issue.path).toContain("experimental");
    }
  });

  test("§6 P1-03: the documented profile names and default match the schema", () => {
    const config = defaultConfig();
    for (const name of ["fast", "balanced", "deep", "quality"]) {
      expect(GLOBAL_CONFIG_TEMPLATE).toContain(name);
      expect(config.model.profiles[name]).toBeDefined();
    }
    // §12's rule 9: the template documents `auto` as the shipped default, so a
    // change to either side has to move both.
    expect(config.model.profile).toBe("auto");
    expect(GLOBAL_CONFIG_TEMPLATE).toContain('# profile = "auto"');
    // The template calls the cache TTL experimental. Saying so is only honest
    // while the registry agrees.
    expect(configKeyInfo(normalizeConfigPath("model.cache.ttl"))?.status).not.toBe("wired");
  });
});