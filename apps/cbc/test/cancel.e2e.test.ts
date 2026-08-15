/**
 * P0-04 end-to-end: a foreground `process.run` is cancellable while in flight.
 *
 * Runs against a real `cbc-runtime` binary (explicit override, debug, or release). The
 * request loop must be concurrent for this to work at all: a single-threaded
 * dispatcher could never receive `runtime.cancel` while `process.run` blocks.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { RuntimeClient, type RuntimeProcess } from "@cbc/protocol";

const BINARY_NAME = process.platform === "win32" ? "cbc-runtime.exe" : "cbc-runtime";
const BINARY_CANDIDATES = [
  ...(process.env.CBC_RUNTIME_BINARY !== undefined
    ? [process.env.CBC_RUNTIME_BINARY]
    : []),
  ...["debug", "release"].map((profile) =>
    fileURLToPath(new URL(`../../../target/${profile}/${BINARY_NAME}`, import.meta.url))
  ),
];
const SLEEP_PROGRAM = process.execPath;
const SLEEP_ARGS = ["-e", "await Bun.sleep(30_000)"] as const;

function runtimeBinary(): string | undefined {
  return BINARY_CANDIDATES.find((candidate) => existsSync(candidate));
}

/** Bun's `FileSink` is not a `WritableStream`; adapt it like production does. */
function sinkToWritable(sink: {
  write(chunk: Uint8Array): number | Promise<number>;
  flush(): number | Promise<number>;
  end(): number | Promise<number>;
}): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    async write(chunk) {
      sink.write(chunk);
      await sink.flush();
    },
    async close() {
      await sink.end();
    },
    async abort() {
      await sink.end();
    },
  });
}

function spawner(binary: string, workspace: string, dataDir: string) {
  return (): RuntimeProcess => {
    const child = Bun.spawn({
      cmd: [binary, "--workspace", workspace, "--data-dir", dataDir],
      cwd: workspace,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      stdin: sinkToWritable(
        child.stdin as unknown as {
          write(chunk: Uint8Array): number | Promise<number>;
          flush(): number | Promise<number>;
          end(): number | Promise<number>;
        },
      ),
      stdout: child.stdout as unknown as ReadableStream<Uint8Array>,
      stderr: child.stderr as unknown as ReadableStream<Uint8Array>,
      exited: child.exited,
      kill: (signal?: number | NodeJS.Signals) => child.kill(signal),
    };
  };
}

describe("runtime.cancel (P0-04)", () => {
  test("an abort signal cancels a foreground process.run mid-flight", async () => {
    const binary = runtimeBinary();
    if (binary === undefined) {
      console.warn("skipping: no debug/release cbc-runtime binary is built");
      return;
    }

    const root = mkdtempSync(join(tmpdir(), "cbc-cancel-"));
    const workspace = join(root, "ws");
    const dataDir = join(root, "data");
    mkdirSync(workspace, { recursive: true });

    const client = new RuntimeClient(
      {
        runtimeBinary: binary,
        workspace,
        clientVersion: "0.1.0-test",
        dataDir,
        pty: false,
        requestTimeoutMs: 60_000,
      },
      spawner(binary, workspace, dataDir),
    );

    try {
      await client.start();
      await client.request("workspace.trust.write", { state: "trusted-always" });
      const capability = await client.issueCapability({
        sessionId: "cancel-test-session",
        callId: "cancel-test-call",
        actionHash: "cancel-test-action",
        operation: "process.run",
        program: SLEEP_PROGRAM,
        args: [...SLEEP_ARGS],
        cwd: ".",
        network: "ask",
        resources: ["env:sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
      });

      const controller = new AbortController();
      const pending = client.request(
        "process.run",
        {
          program: SLEEP_PROGRAM,
          args: [...SLEEP_ARGS],
          cwd: ".",
          network: "ask",
          timeoutMs: 60_000,
          maxOutputBytes: 4_096,
          capabilityReceipt: capability.id,
          capabilitySessionId: capability.sessionId,
          capabilityActionHash: capability.actionHash,
        },
        { signal: controller.signal },
      );

      // Give the process a moment to start, then cancel the turn.
      setTimeout(() => controller.abort(), 700);
      const startedAt = Date.now();
      const outcome = (await pending) as { state: string; durationMs: number };
      const elapsed = Date.now() - startedAt;

      // The 30 s sleep must not run to completion: the response arrives quickly,
      // and the process ends cancelled (or killed by the same blow).
      expect(elapsed).toBeLessThan(15_000);
      expect(["cancelled", "exited", "failed"]).toContain(outcome.state);
    } finally {
      await client.stop().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("runtime.cancel for an unknown request reports cancelled=false, not an error", async () => {
    const binary = runtimeBinary();
    if (binary === undefined) {
      console.warn("skipping: no debug/release cbc-runtime binary is built");
      return;
    }

    const root = mkdtempSync(join(tmpdir(), "cbc-cancel-"));
    const workspace = join(root, "ws");
    const dataDir = join(root, "data");
    mkdirSync(workspace, { recursive: true });

    const client = new RuntimeClient(
      {
        runtimeBinary: binary,
        workspace,
        clientVersion: "0.1.0-test",
        dataDir,
        pty: false,
        requestTimeoutMs: 10_000,
      },
      spawner(binary, workspace, dataDir),
    );

    try {
      await client.start();
      const result = (await client.request("runtime.cancel", { requestId: "99999" })) as {
        cancelled: boolean;
      };
      expect(result.cancelled).toBe(false);
    } finally {
      await client.stop().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
