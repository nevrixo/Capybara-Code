import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { configuredLspServers } from "../src/lsp-host.ts";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/lsp-servers");

interface FamilyFixture {
  readonly family: string;
  readonly languages: readonly string[];
  readonly command: string;
  readonly args: readonly string[];
  readonly extensions: readonly string[];
  readonly capabilities: readonly string[];
}

const REQUIRED_QUERY = [
  "textDocument/definition",
  "textDocument/references",
  "textDocument/hover",
] as const;

function loadFamily(name: string): FamilyFixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as FamilyFixture;
}

describe("LSP language-family fixtures", () => {
  test("web, scripting, and systems fixtures cover query tools", () => {
    const families = ["web.json", "scripting.json", "systems.json"].map(loadFamily);
    expect(new Set(families.map((family) => family.family))).toEqual(
      new Set(["web", "scripting", "systems"]),
    );
    for (const family of families) {
      expect(family.languages.length).toBeGreaterThan(0);
      expect(family.command.length).toBeGreaterThan(0);
      for (const capability of REQUIRED_QUERY) {
        expect(family.capabilities).toContain(capability);
      }
      const servers = configuredLspServers({
        [family.family]: {
          command: family.command,
          args: [...family.args],
          extensions: [...family.extensions],
          languageId: family.languages[0] ?? family.family,
        },
      });
      expect(servers).toHaveLength(1);
      expect(servers[0]?.command).toBe(family.command);
      expect(servers[0]?.extensions).toEqual([...family.extensions]);
    }
  });
});
