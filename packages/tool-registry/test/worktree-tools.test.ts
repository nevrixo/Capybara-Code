import { describe, expect, test } from "bun:test";

import { NATIVE_TOOLS, nativeToolsForFeatures } from "../src/catalog.ts";

describe("worktree tools", () => {
  test("are absent until worktreeMultiAgent is enabled", () => {
    const ids = ["worktree.list", "worktree.inspect", "worktree.create", "worktree.remove", "merge.preview"];
    expect(NATIVE_TOOLS.map((tool) => tool.id)).toEqual(expect.arrayContaining(ids));
    expect(nativeToolsForFeatures().map((tool) => tool.id)).not.toEqual(expect.arrayContaining(ids));
    expect(nativeToolsForFeatures({ worktreeMultiAgent: true }).map((tool) => tool.id)).toEqual(
      expect.arrayContaining(ids),
    );
  });
});
