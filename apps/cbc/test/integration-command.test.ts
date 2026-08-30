import { describe, expect, test } from "bun:test";

import type { Host, HostFs } from "../src/host.ts";
import { CliError, EXIT } from "../src/exit.ts";
import { CommandContext } from "../src/commands/context.ts";
import { githubCommand } from "../src/commands/integrations.ts";

class MemoryFs implements HostFs {
  readonly files = new Map<string, string>();

  async read(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async writeNew(path: string, content: string): Promise<boolean> {
    if (this.files.has(path)) return false;
    this.files.set(path, content);
    return true;
  }

  async atomicWrite(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async list(path: string): Promise<string[]> {
    const prefix = path.replace(/\/$/u, "") + "/";
    return [...this.files.keys()]
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => entry.slice(prefix.length).split("/", 1)[0]!)
      .filter((entry, index, all) => all.indexOf(entry) === index);
  }

  async mkdirp(): Promise<void> {}

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async isDirectory(path: string): Promise<boolean> {
    const prefix = path.replace(/\/$/u, "") + "/";
    return [...this.files.keys()].some((entry) => entry.startsWith(prefix));
  }
}

function fixture() {
  const fs = new MemoryFs();
  const output: string[] = [];
  const errors: string[] = [];
  const host: Host = {
    fs,
    cwd: "C:/repo",
    homeDir: "C:/user",
    executableDir: "C:/bin",
    platform: "win32",
    version: "0.1.0",
    env: {},
    io: {
      stdout(text) { output.push(text); },
      stderr(text) { errors.push(text); },
      async readStdin() { return ""; },
      async prompt() { return ""; },
      async select() { return -1; },
      isTty: false,
      columns: 100,
      rows: 40,
    },
    now: () => 0,
    exit(code): never { throw new Error("exit " + String(code)); },
  };
  return {
    context: new CommandContext({ host, version: "0.1.0", nonInteractive: true }),
    fs,
    output,
    errors,
  };
}

describe("integration CLI commands", () => {
  test("installs a fail-closed GitHub workflow without overwriting an existing file", async () => {
    const first = fixture();
    expect((await githubCommand(first.context, "install")).code).toBe(EXIT.ok);
    const path = "C:/repo/.github/workflows/capybara-code.yml";
    const workflow = first.fs.files.get(path);
    expect(workflow).toContain("permission-policy: allow-listed");
    expect(workflow).toContain("pull-requests: write");
    await expect(githubCommand(first.context, "install")).rejects.toBeInstanceOf(CliError);
  });

  test("diagnoses the GitHub workflow without requiring a running daemon", async () => {
    const current = fixture();
    await githubCommand(current.context, "install");
    expect((await githubCommand(current.context, "doctor")).code).toBe(EXIT.ok);
    expect(current.output.join("")).toContain('"status": "ready"');
    expect(current.output.join("")).toContain('"status": "not-required"');
  });
});
