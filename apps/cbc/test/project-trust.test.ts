import { describe, expect, test } from "bun:test";

import {
  captureProjectTrustSnapshot,
  projectTrustWidening,
} from "../src/project-trust.ts";
import {
  emptyTrustStore,
  emptyProjectControlTrustStore,
  loadEffectiveConfig,
  projectControlTrustMatches,
  readProjectControlTrustStore,
  trustStateFor,
  withProjectControlTrust,
  withTrust,
  writeProjectControlTrustStore,
} from "../src/state.ts";
import { resolvePaths, type Host, type HostFs } from "../src/host.ts";
import { CommandContext } from "../src/commands/context.ts";
import { trustCommand } from "../src/commands/trust.ts";
import { EXIT } from "../src/exit.ts";

class MemoryFs implements HostFs {
  readonly files = new Map<string, string>();

  async read(path: string): Promise<string | undefined> {
    return this.files.get(normalize(path));
  }

  async readPrefix(path: string, maxBytes: number) {
    const content = this.files.get(normalize(path));
    if (content === undefined) return undefined;
    const bytes = Buffer.from(content, "utf8");
    return {
      content: bytes.subarray(0, maxBytes).toString("utf8"),
      truncated: bytes.byteLength > maxBytes,
    };
  }

  async write(path: string, content: string): Promise<void> {
    this.files.set(normalize(path), content);
  }

  async writeNew(path: string, content: string): Promise<boolean> {
    const key = normalize(path);
    if (this.files.has(key)) return false;
    this.files.set(key, content);
    return true;
  }

  async atomicWrite(path: string, content: string): Promise<void> {
    this.files.set(normalize(path), content);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(normalize(path));
  }

  async list(path: string): Promise<string[]> {
    const prefix = normalize(path).replace(/\/$/u, "") + "/";
    return [...this.files.keys()]
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => entry.slice(prefix.length).split("/", 1)[0]!)
      .filter((entry, index, values) => values.indexOf(entry) === index);
  }

  async mkdirp(): Promise<void> {}
  async remove(path: string): Promise<void> { this.files.delete(normalize(path)); }
  async isDirectory(path: string): Promise<boolean> {
    const prefix = normalize(path).replace(/\/$/u, "") + "/";
    return [...this.files.keys()].some((entry) => entry.startsWith(prefix));
  }
  async statIdentity(): Promise<string> { return "volume:file"; }
}

function fixture() {
  const fs = new MemoryFs();
  const output: string[] = [];
  const host: Host = {
    fs,
    cwd: "/repo",
    homeDir: "/home/user",
    executableDir: "/opt/capy/bin",
    platform: "linux",
    version: "0.1.0",
    env: { CAPYBARA_HOME: "/capy" },
    io: {
      stdout(text) { output.push(text); },
      stderr() {},
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
  return { host, fs, output };
}

describe("Project Trust v2", () => {
  test("binds config, package, executable, and capability digests deterministically", async () => {
    const { host, fs } = fixture();
    fs.files.set("/repo/.capybara/config.toml", [
      "[agent.tool_graph]",
      "max_parallel_reads = 2",
      "[mcp.servers.readonly]",
      'command = "readonly-mcp"',
    ].join("\n"));
    fs.files.set("/repo/.capybara/packages.json", JSON.stringify({
      packages: [{ source: "local:tools", permissions: { network: "deny" } }],
    }));
    const first = await captureProjectTrustSnapshot(host, "/repo");
    const second = await captureProjectTrustSnapshot(host, "/repo");
    expect(first).toEqual(second);
    expect(first.hasProjectControlFiles).toBe(true);
    expect(first.requestedCapabilities).toEqual(["mcp", "process"]);
    expect(first.projectDigest).toMatch(/^sha256:[a-f0-9]{64}$/);

    fs.files.set("/repo/.capybara/packages.json", JSON.stringify({
      packages: [{
        source: "local:tools",
        contents: { plugins: ["quality.wasm"] },
        permissions: { network: "allow" },
      }],
    }));
    const widened = await captureProjectTrustSnapshot(host, "/repo");
    expect(widened.projectDigest).not.toBe(first.projectDigest);
    expect(projectTrustWidening(first, widened)).toEqual(["network", "plugin-runtime"]);
  });

  test("invalidates persistent trust when a project control digest changes", async () => {
    const { host, fs } = fixture();
    fs.files.set("/repo/.capybara/config.toml", "[agent.tool_graph]\nmax_parallel_reads = 2\n");
    const approved = await captureProjectTrustSnapshot(host, "/repo");
    const store = withTrust(emptyTrustStore(), {
      path: "/repo",
      state: "trusted-always",
      decidedAt: "2026-08-30T00:00:00.000Z",
      fingerprint: "volume:file",
    });
    const projectStore = withProjectControlTrust(emptyProjectControlTrustStore(), {
      path: "/repo",
      fingerprint: "volume:file",
      decidedAt: "2026-08-30T00:00:00.000Z",
      project: approved,
    });
    expect(trustStateFor(store, "/repo", "volume:file")).toBe("trusted-always");
    expect(projectControlTrustMatches(projectStore, "/repo", "volume:file", approved)).toBe(true);

    fs.files.set("/repo/.capybara/config.toml", "[agent.tool_graph]\nmax_parallel_reads = 3\n");
    const changed = await captureProjectTrustSnapshot(host, "/repo");
    expect(projectControlTrustMatches(projectStore, "/repo", "volume:file", changed)).toBe(false);

    const paths = resolvePaths(host);
    await writeProjectControlTrustStore(host, paths, projectStore);
    const roundTrip = await readProjectControlTrustStore(host, paths);
    expect(roundTrip.records["/repo"]?.project).toEqual(approved);
  });

  test("loads shared and local project config only when trust is active", async () => {
    const { host, fs } = fixture();
    fs.files.set("/repo/.capybara/config.toml", "[agent.tool_graph]\nmax_parallel_reads = 2\n");
    fs.files.set("/repo/.capybara/config.local.toml", "[agent.tool_graph]\nmax_parallel_reads = 3\n");
    const untrusted = await loadEffectiveConfig(host, {
      workspacePath: "/repo",
      projectTrusted: false,
    });
    expect(untrusted.projectConfigApplied).toBe(false);
    expect(untrusted.config.agent.toolGraph.maxParallelReads).not.toBe(3);

    const trusted = await loadEffectiveConfig(host, {
      workspacePath: "/repo",
      projectTrusted: true,
    });
    expect(trusted.projectConfigApplied).toBe(true);
    expect(trusted.config.agent.toolGraph.maxParallelReads).toBe(3);
    expect(trusted.provenance["agent.toolGraph.maxParallelReads"]).toBe("project-local");
  });

  test("show-diff reports digest and requested capabilities without prompting", async () => {
    const { host, fs, output } = fixture();
    fs.files.set("/repo/.capybara/config.toml", [
      "[mcp.servers.readonly]",
      'command = "readonly-mcp"',
    ].join("\n"));
    const context = new CommandContext({ host, version: "0.1.0", nonInteractive: true });
    expect((await trustCommand(context, { showDiff: true })).code).toBe(EXIT.ok);
    const rendered = output.join("");
    expect(rendered).toContain('"currentDigest"');
    expect(rendered).toContain('"mcp"');
    expect(rendered).toContain('"process"');
  });
});

function normalize(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/u, "");
}
