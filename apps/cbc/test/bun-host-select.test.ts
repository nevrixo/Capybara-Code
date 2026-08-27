import { describe, expect, test } from "bun:test";

import { decodeSelectInput } from "../src/bun-host.ts";

describe("Bun host select input", () => {
  test("applies navigation before Enter when the terminal batches both keys", () => {
    expect(decodeSelectInput("\u001B[B\r", 4, 0)).toMatchObject({
      selected: 1,
      decision: 1,
    });
    expect(decodeSelectInput("\u001B[B\u001B[B\r", 4, 0)).toMatchObject({
      selected: 2,
      decision: 2,
    });
  });

  test("maps batched numeric choices to their zero-based decisions", () => {
    expect(decodeSelectInput("2\r", 4, 0)).toMatchObject({ selected: 1, decision: 1 });
    expect(decodeSelectInput("3\r", 4, 0)).toMatchObject({ selected: 2, decision: 2 });
  });

  test("carries a split arrow sequence into the next input chunk", () => {
    const first = decodeSelectInput("\u001B", 4, 0);
    expect(first.pendingSequence).toBe("\u001B");

    expect(decodeSelectInput("[B\r", 4, first.selected, first)).toMatchObject({
      selected: 1,
      decision: 1,
    });
  });
});
