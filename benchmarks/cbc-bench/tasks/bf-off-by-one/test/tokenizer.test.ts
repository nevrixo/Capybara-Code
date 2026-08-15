import { expect, test } from "bun:test";

import { tokenize } from "../src/tokenizer.ts";

test("splits words and numbers", () => {
  const tokens = tokenize("count 42");
  expect(tokens.map((t) => t.text)).toEqual(["count", "42"]);
  expect(tokens.map((t) => t.kind)).toEqual(["word", "number"]);
});

test("keeps single-character tokens", () => {
  // The interesting case: with the off-by-one, a one-character word becomes "".
  expect(tokenize("a").map((t) => t.text)).toEqual(["a"]);
  expect(tokenize("7").map((t) => t.text)).toEqual(["7"]);
});

test("records accurate offsets", () => {
  const [first, second] = tokenize("ab cd");
  expect(first).toMatchObject({ text: "ab", start: 0, end: 2 });
  expect(second).toMatchObject({ text: "cd", start: 3, end: 5 });
});

test("passes symbols through", () => {
  expect(tokenize("a+b").map((t) => t.text)).toEqual(["a", "+", "b"]);
});
