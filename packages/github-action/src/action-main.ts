import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseGitHubTrigger } from "./event.ts";

async function main(): Promise<number> {
  const rawEventPath = requiredEnv("GITHUB_EVENT_PATH");
  const raw = JSON.parse(await readFile(rawEventPath, "utf8")) as unknown;
  const trigger = parseGitHubTrigger({
    eventName: requiredEnv("GITHUB_EVENT_NAME"),
    deliveryId: process.env.GITHUB_DELIVERY_ID ?? requiredEnv("GITHUB_RUN_ID"),
    repository: requiredEnv("GITHUB_REPOSITORY"),
    actor: requiredEnv("GITHUB_ACTOR"),
    ref: requiredEnv("GITHUB_REF"),
    sha: requiredEnv("GITHUB_SHA"),
    payload: raw,
  });
  const runnerTemp = process.env.RUNNER_TEMP ?? process.cwd();
  const envelopePath = join(runnerTemp, "capy-trigger-" + process.pid + ".json");
  const resultPath = process.env.INPUT_RESULT_FILE?.trim() || "capy-result.json";
  const permissionPolicy = process.env.INPUT_PERMISSION_POLICY?.trim() || "allow-listed";
  const binary = resolveBinary(process.env.INPUT_CAPY_BINARY);
  await mkdir(dirname(envelopePath), { recursive: true });
  await writeFile(envelopePath, JSON.stringify(trigger.envelope) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    const code = await spawnCli(binary, [
      "run",
      "--event-file",
      envelopePath,
      "--result-file",
      resultPath,
      "--permission-policy",
      permissionPolicy,
    ]);
    const output = process.env.GITHUB_OUTPUT;
    if (output !== undefined) {
      await writeFile(output, "result-file=" + resolve(resultPath) + "\n", {
        encoding: "utf8",
        flag: "a",
      });
    }
    return code;
  } finally {
    await rm(envelopePath, { force: true });
  }
}

function resolveBinary(configured: string | undefined): string {
  const value = configured?.trim();
  const bundled = join(
    dirname(fileURLToPath(import.meta.url)),
    process.platform === "win32" ? "capy.exe" : "capy",
  );
  const binary = value && value.length > 0 ? value : bundled;
  if (!isAbsolute(binary) || !existsSync(binary)) {
    throw new Error("Capybara Action requires a verified absolute capy binary path");
  }
  return binary;
}

function spawnCli(binary: string, args: readonly string[]): Promise<number> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(binary, [...args], {
      stdio: "inherit",
      env: process.env,
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        reject(new Error("Capybara CLI terminated by " + signal));
        return;
      }
      resolveProcess(code ?? 1);
    });
  });
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(name + " is required");
  return value;
}

if (import.meta.main) {
  process.exitCode = await main().catch((error) => {
    process.stderr.write("Capybara Action: " + (error instanceof Error ? error.message : String(error)) + "\n");
    return 1;
  });
}
