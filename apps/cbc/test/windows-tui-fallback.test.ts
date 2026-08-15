import { expect, test } from "bun:test";

import { supportsNativeOpenTui } from "../src/tui-frame.ts";

test("uses the UTF-8-safe ANSI renderer on Windows", () => {
  expect(supportsNativeOpenTui("linux")).toBe(true);
  expect(supportsNativeOpenTui("win32")).toBe(false);
});
