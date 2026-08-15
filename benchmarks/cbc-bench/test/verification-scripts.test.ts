import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url)).replace(/[\\/]+$/u, "");

interface ScriptResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runScript(relativePath: string, args: readonly string[] = []): Promise<ScriptResult> {
  const child = Bun.spawn({
    cmd: [process.execPath, "run", join(ROOT, relativePath), ...args],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function expectSuccess(result: ScriptResult, label: string): void {
  expect(result.exitCode, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
}

describe("repository verification scripts", () => {
  test("protocol, schemas, TypeScript, and Rust declarations have no drift", async () => {
    expectSuccess(
      await runScript("scripts/check-protocol-drift.ts"),
      "check-protocol-drift.ts",
    );
  }, 60_000);

  test("the production runtime boundary contains no Codex runtime dependency", async () => {
    expectSuccess(
      await runScript("scripts/check-no-codex-runtime.ts"),
      "check-no-codex-runtime.ts",
    );
  }, 60_000);

  test("checked-in generated fixtures match their canonical generator", async () => {
    expectSuccess(
      await runScript("fixtures/generate.ts", ["--check"]),
      "fixtures/generate.ts --check",
    );
  }, 60_000);

  test("the checked-in source-truth manifest matches the current repository", async () => {
    expectSuccess(
      await runScript("scripts/source-truth.ts", ["--check"]),
      "source-truth.ts --check",
    );
  }, 60_000);
});
