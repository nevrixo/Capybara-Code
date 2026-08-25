import { describe, expect, test } from "bun:test";

import { parseSlash, SLASH_COMMANDS } from "../src/slash.ts";

describe("Mode slash controls", () => {
  test("uses /mode build instead of the removed /build alias", () => {
    expect(parseSlash("/mode build")).toEqual({ kind: "set_mode", mode: "build" });
    expect(parseSlash("/build")).toMatchObject({ kind: "unknown", name: "/build" });
    expect(SLASH_COMMANDS.some((command) => command.name === "/build")).toBe(false);
  });

  test("routes /memory inspect locally", () => {
    expect(parseSlash("/memory inspect")).toEqual({ kind: "memory", action: "inspect" });
    expect(SLASH_COMMANDS.some((command) => command.name === "/memory")).toBe(true);
  });
});
