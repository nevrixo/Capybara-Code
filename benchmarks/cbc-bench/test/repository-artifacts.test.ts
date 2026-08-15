import { describe, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkSourceTruth } from "../../../scripts/source-truth.ts";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url)).replace(/[\\/]+$/u, "");

describe("repository artifacts", () => {
  test("checked-in source-truth manifest matches every canonical source", async () => {
    const result = await checkSourceTruth(ROOT);
    expect(result.ok, result.message).toBe(true);
    expect(result.current.files.some((entry) => entry.path === "benchmarks/cbc-bench/cohort-manifest.json"))
      .toBe(true);
  });

  test("README links the benchmark operations guide", async () => {
    const readme = await readFile(join(ROOT, "README.md"), "utf8");
    const path = "benchmarks/cbc-bench/README.md";
    expect(readme, path).toContain(path);
    expect((await stat(join(ROOT, path))).isFile(), path).toBe(true);
  });
});
