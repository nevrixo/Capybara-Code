/**
 * §5.18: key-status.ts is the single source of truth for user configuration, and
 * the default `/setting` surface hides keys nothing consumes.
 *
 * §5.19 turns that into a measurable criterion — zero user-visible no-op settings
 * in the default profile — so the rule is asserted here rather than left to
 * whoever next edits the picker.
 */

import { describe, expect, test } from "bun:test";

import { configKeyInfo } from "@cbc/config-schema";

import { isWiredSettingRow } from "../src/commands/interactive.ts";

describe("the /setting surface only offers keys that do something (§5.18)", () => {
  test("an experimental key is hidden", () => {
    const experimental = "ui.color";
    // Guard the fixture: this test is only meaningful while that key really is
    // experimental, and promoting it should fail here rather than silently pass.
    expect(configKeyInfo(experimental)?.status).toBe("experimental");
    expect(isWiredSettingRow({ configPath: experimental })).toBe(false);
  });

  test("a deprecated key is hidden", () => {
    const deprecated = "ui.thinkingVisibility";
    expect(configKeyInfo(deprecated)?.status).toBe("deprecated");
    expect(isWiredSettingRow({ configPath: deprecated })).toBe(false);
  });

  test("a wired key is offered", () => {
    expect(configKeyInfo("ui.thinkingMode")?.status).toBe("wired");
    expect(isWiredSettingRow({ configPath: "ui.thinkingMode" })).toBe(true);
  });

  test("a session action with no config key is always offered", () => {
    // The TODO row opens a panel; it is not a setting, so no key's status could
    // make it a no-op.
    expect(isWiredSettingRow({})).toBe(true);
  });

  test("an unregistered key is offered rather than silently dropped", () => {
    // A missing entry is a gap in the table. Hiding a working toggle over it
    // would be a worse failure than showing one whose status nobody recorded.
    expect(configKeyInfo("ui.notARealKey")).toBeUndefined();
    expect(isWiredSettingRow({ configPath: "ui.notARealKey" })).toBe(true);
  });
});
