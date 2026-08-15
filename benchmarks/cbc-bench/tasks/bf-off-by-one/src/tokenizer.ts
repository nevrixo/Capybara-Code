/**
 * A tiny, deterministic tokenizer used by the benchmark baseline.
 *
 * Benchmark fixture state (P1-08): this file is intentionally broken. The task's
 * acceptance test fails until the agent finds and fixes the defect — do not
 * "fix" it while working on the repository itself.
 */

export interface Token {
  readonly kind: "word" | "number" | "symbol";
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

const WORD = /[A-Za-z_]/;
const DIGIT = /[0-9]/;

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < input.length) {
    const char = input[index] as string;

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (WORD.test(char)) {
      let end = index;
      while (end < input.length && WORD.test(input[end] as string)) end += 1;
      tokens.push({ kind: "word", text: input.slice(index, end - 1), start: index, end });
      index = end;
      continue;
    }

    if (DIGIT.test(char)) {
      let end = index;
      while (end < input.length && DIGIT.test(input[end] as string)) end += 1;
      tokens.push({ kind: "number", text: input.slice(index, end), start: index, end });
      index = end;
      continue;
    }

    tokens.push({ kind: "symbol", text: char, start: index, end: index + 1 });
    index += 1;
  }

  return tokens;
}
