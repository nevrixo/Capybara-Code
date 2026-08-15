import { describe, expect, test } from "bun:test";

import { TerminalInputDecoder } from "../src/bun-host.ts";

describe("TerminalInputDecoder", () => {
  test("waits for a split UTF-8 Hangul character before deciding on CP949", () => {
    const decoder = new TerminalInputDecoder();
    const bytes = Buffer.from("\uAC00", "utf8");

    // EA B0 is a valid CP949 pair, but it is also the beginning of UTF-8 \uAC00.
    // The old decoder committed CP949 here and emitted mojibake plus U+FFFD.
    expect(decoder.decode(bytes.subarray(0, 2))).toBe("");
    expect(decoder.decode(bytes.subarray(2))).toBe("\uAC00");
  });

  test("keeps an ASCII prefix while a following UTF-8 Hangul character is split", () => {
    const decoder = new TerminalInputDecoder();
    const bytes = Buffer.from("x\uAC00", "utf8");

    expect(decoder.decode(bytes.subarray(0, 3))).toBe("x");
    expect(decoder.decode(bytes.subarray(3))).toBe("\uAC00");
  });


  test("keeps a split UTF-8 character whose second byte is 0x80 pending", () => {
    const decoder = new TerminalInputDecoder();
    const bytes = Buffer.from("\uB000", "utf8");

    expect(decoder.decode(bytes.subarray(0, 2))).toBe("");
    expect(decoder.decode(bytes.subarray(2))).toBe("\uB000");
  });

  test("flushes a legacy CP949 pair left at an idle input boundary", () => {
    const bytes = Buffer.from([0xea, 0xb0]);
    const expected = new TextDecoder(
      "windows-949" as unknown as ConstructorParameters<typeof TextDecoder>[0],
    ).decode(bytes);
    const decoder = new TerminalInputDecoder();

    expect(decoder.decode(bytes)).toBe("");
    expect(decoder.hasPendingInput).toBe(true);
    expect(decoder.flush()).toBe(expected);
    expect(decoder.hasPendingInput).toBe(false);
  });
});
