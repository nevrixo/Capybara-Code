import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clipboardCommands,
  createBunHost,
  encodeClipboardText,
  formatFilesystemIdentity,
} from "../src/bun-host.ts";

describe("Bun host clipboard encoding", () => {
  test("sends Windows clip.exe UTF-16LE input so Hangul remains Unicode", () => {
    const [command] = clipboardCommands("win32");

    expect(command).toEqual({ argv: ["clip.exe"], inputEncoding: "utf16le" });
    const bytes = encodeClipboardText("한글 😀", command!.inputEncoding);
    expect([...bytes]).toEqual([0x5c, 0xd5, 0x00, 0xae, 0x20, 0x00, 0x3d, 0xd8, 0x00, 0xde]);
    expect(Buffer.from(bytes).toString("utf16le")).toBe("한글 😀");
  });

  test("keeps Unix clipboard commands on UTF-8", () => {
    const [command] = clipboardCommands("linux");

    expect(command).toEqual({ argv: ["wl-copy"], inputEncoding: "utf8" });
    const bytes = encodeClipboardText("한글 😀", command!.inputEncoding);
    expect(Buffer.from(bytes).toString("utf8")).toBe("한글 😀");
  });
});

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
