import { describe, expect, test } from "bun:test";

import { parseSlash, slashArgumentValues } from "../src/slash.ts";

describe("Plan slash controls", () => {
  test("keeps bare /plan compatible while preserving explicit actions", () => {
    expect(parseSlash("/plan")).toEqual({ kind: "set_mode", mode: "plan" });
    expect(parseSlash("/plan enter")).toMatchObject({ kind: "plan", action: "enter" });
    expect(parseSlash("/plan show")).toMatchObject({ kind: "plan", action: "show" });
  });

  test("preserves refinement text and context strategy", () => {
    expect(parseSlash("/plan refine remove deploy and keep local verification")).toMatchObject({
      kind: "plan",
      action: "refine",
      instruction: "remove deploy and keep local verification",
      text: "remove deploy and keep local verification",
    });
    expect(parseSlash("/plan approve --keep")).toMatchObject({
      kind: "plan",
      action: "approve",
      contextStrategy: "keep",
    });
    expect(parseSlash("/plan execute --compact")).toMatchObject({
      kind: "plan",
      action: "execute",
      contextStrategy: "compact",
    });
  });

  test("offers action completion values", () => {
    expect(slashArgumentValues({ command: "/plan", index: 0, argument: undefined, query: "" })?.map((entry) => entry.value)).toEqual([
      "enter", "show", "refine", "approve", "execute",
    ]);
  });
});
