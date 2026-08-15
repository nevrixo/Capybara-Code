import { describe, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkSourceTruth } from "../../../scripts/source-truth.ts";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url)).replace(/[\\/]+$/u, "");

describe("performance-program repository artifacts", () => {
  test("checked-in source-truth manifest matches every canonical source and document", async () => {
    const result = await checkSourceTruth(ROOT);
    expect(result.ok, result.message).toBe(true);
    expect(result.current.files.some((entry) => entry.path === "benchmarks/cbc-bench/cohort-manifest.json"))
      .toBe(true);
    expect(result.current.files.some((entry) => entry.path === "docs/performance-program-rollback-runbook.md"))
      .toBe(true);
  });

  test("README links every required implementation and operations document", async () => {
    const readme = await readFile(join(ROOT, "README.md"), "utf8");
    const paths = [
      "docs/capybara-context-agent-performance-improvement-plan.md",
      "docs/adr/0001-harness-latency-program.md",
      "docs/performance-program-rollback-runbook.md",
      "docs/release-notes-performance-program.md",
      "benchmarks/cbc-bench/README.md",
    ];
    for (const path of paths) {
      expect(readme, path).toContain(path);
      expect((await stat(join(ROOT, path))).isFile(), path).toBe(true);
    }
  });

  test("implementation documents distinguish code completion from empirical release evidence", async () => {
    const implementation = await readFile(
      join(ROOT, "docs", "capybara-context-agent-performance-improvement-plan.md"),
      "utf8",
    );
    const releaseNotes = await readFile(
      join(ROOT, "docs", "release-notes-performance-program.md"),
      "utf8",
    );

    expect(implementation).toContain("출시 판정 상태: **미측정**");
    expect(implementation).toContain("실제 paired artifact");
    expect(releaseNotes).toContain("**Unreleased.**");
    expect(releaseNotes).toContain("does **not** state that latency multipliers");
  });
});
