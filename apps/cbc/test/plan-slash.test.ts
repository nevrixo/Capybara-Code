import { describe, expect, test } from "bun:test";

import { parseSlash, SLASH_COMMANDS } from "../src/slash.ts";

describe("Plan slash controls", () => {
  test("uses /mode plan instead of the removed /plan command", () => {
    expect(parseSlash("/mode plan")).toEqual({ kind: "set_mode", mode: "plan" });

    for (const input of [
      "/plan",
      "/plan enter",
      "/plan approve --keep",
      "/plan execute --compact",
    ]) {
      expect(parseSlash(input)).toMatchObject({ kind: "unknown", name: "/plan" });
    }

    expect(SLASH_COMMANDS.some((command) => command.name === "/plan")).toBe(false);
  });
});
