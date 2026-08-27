import { describe, expect, test } from "bun:test";

import { CommandContext } from "../src/commands/context.ts";
import type { Host, HostFs, HostIo } from "../src/host.ts";
import type { ReleaseCandidate } from "../src/update-check.ts";
import {
  ensureUpdatePrompt,
  printUpdateGuidance,
  renderUpdateBoxLines,
} from "../src/update-prompt.ts";

interface PromptHost extends Host {
  readonly out: string[];
  readonly files: Map<string, string>;
  readonly presentedChoices: string[][];
  selections: number[];
}

function createPromptHost(
  selections: number[],
  env: Record<string, string | undefined> = {},
): PromptHost {
  const out: string[] = [];
  const files = new Map<string, string>();
  const presentedChoices: string[][] = [];
  const normalize = (path: string): string => path.replace(/\\/g, "/").replace(/\/+$/, "");

  const io: HostIo = {
    stdout: (text) => {
      out.push(text);
    },
    stderr: () => undefined,
    readStdin: async () => "",
    prompt: async () => "",
    select: async (_question, choices) => {
      presentedChoices.push([...choices]);
      return selections.shift() ?? -1;
    },
    isTty: true,
    columns: 100,
    rows: 30,
  };

  const fs: HostFs = {
    read: async (path) => files.get(normalize(path)),
    write: async (path, content) => {
      files.set(normalize(path), content);
    },
    atomicWrite: async (path, content) => {
      files.set(normalize(path), content);
    },
    exists: async (path) => files.has(normalize(path)),
    list: async () => [],
    mkdirp: async () => undefined,
    remove: async () => undefined,
    isDirectory: async () => false,
  };

  return {
    io,
    fs,
    env,
    cwd: "/work/project",
    homeDir: "/home/dev",
    platform: "linux",
    version: "0.1.1-alpha.7",
    executableDir: "/opt/capybara/bin",
    now: () => 1_800_000_000_000,
    exit: (code) => {
      throw new Error(`exit ${code}`);
    },
    out,
    files,
    presentedChoices,
    selections,
  };
}

function contextFor(
  selections: number[],
  env: Record<string, string | undefined> = {},
): { context: CommandContext; host: PromptHost } {
  const host = createPromptHost(selections, env);
  return { context: new CommandContext({ host, version: "0.1.1-alpha.7" }), host };
}

const candidate: ReleaseCandidate = {
  version: "0.1.1-alpha.8",
  tag: "v0.1.1-alpha.8",
  htmlUrl: "https://github.com/nevrixo/Capybara-Code/releases/tag/v0.1.1-alpha.8",
};

describe("update prompt (§5.1, §5.4)", () => {
  test("the box carries both versions, the source, and the release URL", () => {
    const text = renderUpdateBoxLines("0.1.1-alpha.7", candidate, 80).join("\n");
    expect(text).toContain("A new version of Capybara Code is available");
    expect(text).toContain("0.1.1-alpha.7");
    expect(text).toContain("0.1.1-alpha.8");
    expect(text).toContain("github.com/nevrixo/Capybara-Code");
    expect(text).toContain("releases/tag/v0.1.1-alpha.8");
    expect(text).toContain("╭");
    expect(text).toContain("╰");
  });

  test("every box row has the same display width", () => {
    const lines = renderUpdateBoxLines("0.1.1-alpha.7", candidate, 54)
      .filter((lineText) => lineText.includes("│") || lineText.includes("╭") || lineText.includes("╰"));
    const widths = new Set(
      lines.map((lineText) => lineText.replace(/\u001B\[[0-9;]*m/g, "").length),
    );
    expect(widths.size).toBe(1);
  });

  test("Update now, Next time, and Esc map to update and later", async () => {
    expect(await ensureUpdatePrompt(contextFor([0]).context, candidate)).toBe("update");
    expect(await ensureUpdatePrompt(contextFor([1]).context, candidate)).toBe("later");
    // -1 is what the host returns for Esc / cancel.
    expect(await ensureUpdatePrompt(contextFor([]).context, candidate)).toBe("later");
  });

  test("the launcher package manager and next-run choice are explicit", async () => {
    const { context, host } = contextFor([1], {
      CAPYBARA_UPDATE_MANAGER: "bun",
      CAPYBARA_UPDATE_REQUEST_FILE: "/tmp/capy-update/request.json",
    });
    expect(await ensureUpdatePrompt(context, candidate)).toBe("later");
    expect(host.presentedChoices[0]).toEqual([
      "1. Update now with bun",
      "2. Remind me next time",
    ]);
  });

  test("manual guidance prints exact-version commands and the release URL", () => {
    const { context, host } = contextFor([]);
    printUpdateGuidance(context, candidate);
    const text = host.out.join("\n");
    expect(text).toContain("npm install -g capybara-code@0.1.1-alpha.8");
    expect(text).toContain("bun install -g capybara-code@0.1.1-alpha.8");
    expect(text).toContain(candidate.htmlUrl);
    expect(text).toContain("SHA256SUMS.txt");
    expect(text.includes("capybara-code@alpha")).toBe(false);
    expect(text.includes("capybara-code@latest")).toBe(false);
  });

  test("the prompt never offers to exit the process", () => {
    const text = renderUpdateBoxLines("0.1.1-alpha.7", candidate, 80).join("\n");
    expect(text.includes("No, exit")).toBe(false);
  });
});
