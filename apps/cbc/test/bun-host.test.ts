import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBunHost, formatFilesystemIdentity } from "../src/bun-host.ts";

describe("Bun host filesystem identity", () => {
  test("preserves a Windows file index above Number's exact integer range", () => {
    expect(formatFilesystemIdentity(217154459n, 30117822508685369n)).toBe(
      "217154459:30117822508685369",
    );
    expect(formatFilesystemIdentity(0n, 0n)).toBeUndefined();
  });

  test("matches the exact bigint identity reported by the host filesystem", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cbc-host-identity-"));
    try {
      const metadata = await stat(directory, { bigint: true });
      const host = createBunHost("test");
      expect(await host.fs.statIdentity?.(directory)).toBe(
        formatFilesystemIdentity(metadata.dev, metadata.ino),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
