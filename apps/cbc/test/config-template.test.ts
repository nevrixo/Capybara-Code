import { describe, expect, test } from "bun:test";

import { loadConfig } from "@cbc/config-schema";

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
});