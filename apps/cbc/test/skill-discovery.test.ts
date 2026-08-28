import { describe, expect, test } from "bun:test";

import { defaultConfig, type SkillsConfig } from "@cbc/config-schema";
import { SkillRegistry } from "@cbc/skills";

import { resolvePaths, type Host, type HostFs, type HostIo } from "../src/host.ts";
import { skillDiscoveryStartupNotice } from "../src/skill-diagnostics.ts";
import {
  SkillDiscoveryService,
  skillRoots,
  type SkillDiscoveryInput,
} from "../src/skill-discovery.ts";

interface MemoryHost extends Host {
  readonly files: Map<string, string>;
  readonly canonical: Map<string, string>;
  readonly failLists: Set<string>;
}

function memoryHost(options: {
  cwd?: string;
  home?: string;
  env?: Record<string, string | undefined>;
  platform?: string;
} = {}): MemoryHost {
  const files = new Map<string, string>();
  const canonical = new Map<string, string>();
  const failLists = new Set<string>();
  const normalize = (path: string): string => path.replace(/\\/g, "/").replace(/\/+$/, "");
  const io: HostIo = {
    stdout: () => true,
    stderr: () => undefined,
    readStdin: async () => "",
    prompt: async () => "",
    select: async () => -1,
    isTty: false,
    columns: 100,
    rows: 30,
  };
  const fs: HostFs = {
    read: async (path) => files.get(normalize(path)),
    readPrefix: async (path, maxBytes) => {
      const content = files.get(normalize(path));
      if (content === undefined) return undefined;
      const bytes = Buffer.from(content, "utf8");
      return { content: bytes.subarray(0, maxBytes).toString("utf8"), truncated: bytes.length > maxBytes };
    },
    write: async (path, content) => { files.set(normalize(path), content); },
    atomicWrite: async (path, content) => { files.set(normalize(path), content); },
    exists: async (path) => {
      const target = normalize(path);
      if (files.has(target)) return true;
      const prefix = `${target}/`;
      return [...files.keys()].some((candidate) => candidate.startsWith(prefix));
    },
    list: async (path) => {
      if (failLists.has(normalize(path))) throw new Error(`cannot list ${normalize(path)}`);
      const prefix = `${normalize(path)}/`;
      const names = new Set<string>();
      for (const candidate of files.keys()) {
        if (!candidate.startsWith(prefix)) continue;
        const remainder = candidate.slice(prefix.length);
        const name = remainder.split("/")[0];
        if (name !== undefined && name.length > 0) names.add(name);
      }
      return [...names];
    },
    mkdirp: async () => undefined,
    remove: async (path) => {
      const target = normalize(path);
      for (const candidate of [...files.keys()]) {
        if (candidate === target || candidate.startsWith(`${target}/`)) files.delete(candidate);
      }
    },
    isDirectory: async (path) => {
      const prefix = `${normalize(path)}/`;
      return [...files.keys()].some((candidate) => candidate.startsWith(prefix));
    },
    realpath: async (path) => canonical.get(normalize(path)) ?? normalize(path),
    statIdentity: async () => "1:2",
  };
  let now = 1_800_000_000_000;
  return {
    io,
    fs,
    files,
    canonical,
    failLists,
    env: options.env ?? {},
    cwd: options.cwd ?? "/repo",
    homeDir: options.home ?? "/home/me",
    platform: options.platform ?? "linux",
    version: "0.1.1-alpha.9",
    executableDir: "/opt/capybara/bin",
    now: () => now++,
    exit: (code) => { throw new Error(`exit ${code}`); },
  };
}

function skill(name: string, description = name): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\nbody for ${name}\n`;
}

function skillsConfig(overrides: Partial<SkillsConfig> = {}): SkillsConfig {
  const defaults = defaultConfig().skills;
  return {
    ...defaults,
    ...overrides,
    builtin: { ...defaults.builtin, enabled: false, ...(overrides.builtin ?? {}) },
  };
}

function input(host: MemoryHost, config: SkillsConfig = skillsConfig()): SkillDiscoveryInput {
  return {
    cwd: host.cwd,
    workspacePath: host.cwd,
    nativeSkillsPath: resolvePaths(host).skills,
    config,
  };
}

function service(host: MemoryHost, workspaceTrusted = true): {
  readonly registry: SkillRegistry;
  readonly discovery: SkillDiscoveryService;
} {
  const registry = new SkillRegistry({ productVersion: host.version, workspaceTrusted });
  return {
    registry,
    discovery: new SkillDiscoveryService({
      host,
      replace: (files) => registry.replace(registry.prepare(files)),
    }),
  };
}

describe("Skills Discovery v2 roots and recursive scan", () => {
  test("uses resolvePaths().skills as the native global source of truth", async () => {
    const host = memoryHost({ env: { XDG_CONFIG_HOME: "/xdg" } });
    host.files.set("/xdg/capybara/skills/native/SKILL.md", skill("native"));
    const { discovery } = service(host);
    const snapshot = await discovery.discover(input(host));
    expect(snapshot.accepted.find((definition) => definition.manifest.name === "native")?.origin).toBe("capybara");
    expect(snapshot.roots.some((root) => root.directory === "/xdg/capybara/skills")).toBe(true);
  });

  test("discovers native Skills through CAPYBARA_HOME, CAPYBARA_CONFIG, and Windows APPDATA", async () => {
    const cases = [
      {
        host: memoryHost({ env: { CAPYBARA_HOME: "/tmp/capy" } }),
        expected: "/tmp/capy/config/skills",
      },
      {
        host: memoryHost({ env: { CAPYBARA_CONFIG: "/etc/capybara/custom.toml" } }),
        expected: "/etc/capybara/skills",
      },
      {
        host: memoryHost({
          cwd: "C:/repo",
          home: "C:/Users/me",
          platform: "win32",
          env: { APPDATA: "C:/Users/me/AppData/Roaming" },
        }),
        expected: "C:/Users/me/AppData/Roaming/capybara/skills",
      },
    ];
    for (const [index, entry] of cases.entries()) {
      entry.host.files.set(`${entry.expected}/native-${index}/SKILL.md`, skill(`native-${index}`));
      const snapshot = await service(entry.host).discovery.discover(input(entry.host));
      expect(snapshot.accepted.some((definition) => definition.manifest.name === `native-${index}`)).toBe(true);
    }
  });

  test("shows the startup notice only for rejected external candidates", async () => {
    const fresh = memoryHost();
    const freshSnapshot = await service(fresh).discovery.discover(input(fresh, defaultConfig().skills));
    expect(skillDiscoveryStartupNotice(freshSnapshot)).toBeUndefined();

    const rejected = memoryHost();
    rejected.files.set("/repo/.git/HEAD", "main");
    rejected.files.set("/repo/.capybara/skills/broken/SKILL.md", "---\nname: broken\n---\nbody\n");
    const rejectedSnapshot = await service(rejected).discovery.discover(input(rejected, defaultConfig().skills));
    expect(skillDiscoveryStartupNotice(rejectedSnapshot)).toContain("/skills doctor");
  });

  test("walks from a subdirectory to the Git worktree and recursively finds OpenCode Skills", async () => {
    const host = memoryHost({ cwd: "/repo/packages/app" });
    host.files.set("/repo/.git/HEAD", "ref: refs/heads/main\n");
    host.files.set("/repo/.opencode/skills/team/backend/release/SKILL.md", skill("release"));
    const { discovery } = service(host);
    const snapshot = await discovery.discover(input(host));
    const release = snapshot.accepted.find((definition) => definition.manifest.name === "release");
    expect(snapshot.worktreeRoot).toBe("/repo");
    expect(release?.origin).toBe("opencode");
    expect(release?.scope).toBe("project");
  });

  test("stops a non-Git upward walk at the configured workspace root", async () => {
    const host = memoryHost({ cwd: "/workspace/packages/app" });
    host.files.set("/workspace/.capybara/skills/rooted/SKILL.md", skill("rooted"));
    const { discovery } = service(host);
    const snapshot = await discovery.discover({
      ...input(host),
      workspacePath: "/workspace",
    });
    expect(snapshot.worktreeRoot).toBeUndefined();
    expect(snapshot.accepted.some((definition) => definition.manifest.name === "rooted")).toBe(true);
    expect(snapshot.roots.some((root) => root.directory.startsWith("/workspace/../"))).toBe(false);
  });

  test("builds native, OpenCode, Agents, Claude, legacy, and explicit roots", async () => {
    const host = memoryHost({ cwd: "/repo/app", env: { XDG_CONFIG_HOME: "/xdg" } });
    host.files.set("/repo/.git/HEAD", "main");
    const roots = await skillRoots(host, input(host, skillsConfig({ paths: ["./shared", "~/team"] })));
    const paths = roots.map((root) => root.directory);
    expect(paths).toContain("/repo/.capybara/skills");
    expect(paths).toContain("/repo/.opencode/skills");
    expect(paths).toContain("/repo/.agents/skills");
    expect(paths).toContain("/repo/.claude/skills");
    expect(paths).toContain("/xdg/opencode/skills");
    expect(paths).toContain("/home/me/.agents/skills");
    expect(paths).toContain("/home/me/.claude/skills");
    expect(paths).toContain("/xdg/capybara-code/skills");
    expect(paths).toContain("/repo/app/shared");
    expect(paths).toContain("/home/me/team");
  });

  test("honours depth and candidate limits without scanning excluded subtrees", async () => {
    const host = memoryHost();
    host.files.set("/repo/.git/HEAD", "main");
    host.files.set("/repo/.capybara/skills/direct/SKILL.md", skill("direct"));
    host.files.set("/repo/.capybara/skills/a/b/deep/SKILL.md", skill("deep"));
    host.files.set("/repo/.capybara/skills/node_modules/ignored/SKILL.md", skill("ignored"));
    const { discovery } = service(host);
    const snapshot = await discovery.discover(input(host, skillsConfig({ maxDepth: 1, maxCandidates: 1 })));
    expect(snapshot.accepted.map((definition) => definition.manifest.name)).toEqual(["direct"]);
    expect(snapshot.accepted.some((definition) => definition.manifest.name === "ignored")).toBe(false);
  });

  test("counts rejected SKILL.md files as candidates for diagnostics and budgets", async () => {
    const host = memoryHost();
    host.files.set("/repo/.git/HEAD", "main");
    host.files.set("/repo/.capybara/skills/broken/SKILL.md", "---\nname: broken\n---\nbody\n");
    const { discovery } = service(host);
    const snapshot = await discovery.discover(input(host));
    const root = snapshot.roots.find((candidate) => candidate.directory === "/repo/.capybara/skills");
    expect(root?.candidates).toBe(1);
    expect(snapshot.rejected.some((issue) => issue.path.endsWith("/broken/SKILL.md"))).toBe(true);
  });

  test("refuses discovery when a host cannot guarantee bounded reads", async () => {
    const host = memoryHost();
    host.files.set("/repo/.git/HEAD", "main");
    host.files.set("/repo/.capybara/skills/unsafe/SKILL.md", skill("unsafe"));
    delete (host.fs as { readPrefix?: HostFs["readPrefix"] }).readPrefix;
    const { discovery } = service(host);
    const snapshot = await discovery.discover(input(host));
    expect(snapshot.accepted.some((definition) => definition.manifest.name === "unsafe")).toBe(false);
    expect(snapshot.rejected.some((issue) => issue.message.includes("bounded file reads"))).toBe(true);
  });

  test("rejects frontmatter that does not close inside the 32 KiB catalog prefix", async () => {
    const host = memoryHost();
    host.files.set("/repo/.git/HEAD", "main");
    host.files.set(
      "/repo/.capybara/skills/oversized/SKILL.md",
      `---\nname: oversized\ndescription: ${"x".repeat(33_000)}\n---\nbody\n`,
    );
    const snapshot = await service(host).discovery.discover(input(host));
    expect(snapshot.accepted.some((definition) => definition.manifest.name === "oversized")).toBe(false);
    expect(snapshot.rejected.some((issue) => issue.message.includes("catalog limit"))).toBe(true);
  });
});

describe("Skills Discovery v2 deterministic resolution and trust", () => {
  test("near project beats parent, native beats compatibility, and project beats user", async () => {
    const host = memoryHost({ cwd: "/repo/app" });
    host.files.set("/repo/.git/HEAD", "main");
    host.files.set("/repo/app/.capybara/skills/same/SKILL.md", skill("same", "near native"));
    host.files.set("/repo/app/.agents/skills/same/SKILL.md", skill("same", "near agents"));
    host.files.set("/repo/.capybara/skills/same/SKILL.md", skill("same", "parent native"));
    host.files.set(`${resolvePaths(host).skills}/same/SKILL.md`, skill("same", "user"));
    const { discovery } = service(host);
    const snapshot = await discovery.discover(input(host));
    const winner = snapshot.accepted.find((definition) => definition.manifest.name === "same");
    expect(winner?.manifest.description).toBe("near native");
    expect(snapshot.shadowed).toHaveLength(3);
  });

  test("canonical aliases emit one catalog entry and a dedupe diagnostic", async () => {
    const host = memoryHost();
    const agents = "/home/me/.agents/skills/shared/SKILL.md";
    const claude = "/home/me/.claude/skills/shared/SKILL.md";
    host.files.set(agents, skill("shared"));
    host.files.set(claude, skill("shared"));
    host.canonical.set("/home/me/.claude/skills", "/home/me/.agents/skills");
    host.canonical.set("/home/me/.claude/skills/shared", "/home/me/.agents/skills/shared");
    host.canonical.set(claude, agents);
    const { discovery } = service(host);
    const snapshot = await discovery.discover(input(host));
    expect(snapshot.accepted.filter((definition) => definition.manifest.name === "shared")).toHaveLength(1);
    expect(snapshot.deduplicated).toHaveLength(1);
    expect(snapshot.digest).toHaveLength(64);
  });

  test("accepts project symlinks that stay inside the declared root and bounds cycles", async () => {
    const host = memoryHost();
    host.files.set("/repo/.git/HEAD", "main");
    const root = "/repo/.capybara/skills";
    const linked = `${root}/linked/SKILL.md`;
    host.files.set(linked, skill("linked"));
    host.canonical.set(`${root}/linked`, `${root}/real-linked`);
    host.canonical.set(linked, `${root}/real-linked/SKILL.md`);
    host.files.set(`${root}/loop/placeholder.txt`, "x");
    host.canonical.set(`${root}/loop`, root);
    const snapshot = await service(host).discovery.discover(input(host));
    expect(snapshot.accepted.some((definition) => definition.manifest.name === "linked")).toBe(true);
    expect(snapshot.diagnostics.some((issue) => issue.message.includes("symlink cycle"))).toBe(true);
  });

  test("rejects a project-root symlink escape before reading a Skill body", async () => {
    const host = memoryHost();
    host.files.set("/repo/.git/HEAD", "main");
    const path = "/repo/.agents/skills/escape/SKILL.md";
    host.files.set(path, skill("escape"));
    host.canonical.set("/repo/.agents/skills/escape", "/outside/escape");
    host.canonical.set(path, "/outside/escape/SKILL.md");
    const { discovery } = service(host, false);
    const snapshot = await discovery.discover(input(host));
    expect(snapshot.accepted.some((definition) => definition.manifest.name === "escape")).toBe(false);
    expect(snapshot.rejected.some((issue) => issue.message.includes("escapes"))).toBe(true);
  });

  test("classifies a global symlink into the worktree as project content", async () => {
    const host = memoryHost();
    host.files.set("/repo/.git/HEAD", "main");
    const global = "/home/me/.agents/skills/local/SKILL.md";
    host.files.set(global, skill("local"));
    host.canonical.set(global, "/repo/tools/local/SKILL.md");
    const { discovery, registry } = service(host, false);
    const snapshot = await discovery.discover(input(host));
    const local = snapshot.accepted.find((definition) => definition.manifest.name === "local");
    expect(local?.scope).toBe("project");
    expect((await registry.loadAsync("local")).ok).toBe(false);
  });

  test("loads a global symlink into the worktree after project trust is granted", async () => {
    const host = memoryHost();
    host.files.set("/repo/.git/HEAD", "main");
    const global = "/home/me/.agents/skills/local/SKILL.md";
    host.files.set(global, skill("local"));
    host.canonical.set(global, "/repo/tools/local/SKILL.md");
    const { discovery, registry } = service(host, true);
    await discovery.discover(input(host));
    expect((await registry.loadAsync("local")).ok).toBe(true);
  });

  test("explicit project roots beat native roots and bundled definitions", async () => {
    const host = memoryHost();
    host.files.set("/repo/.git/HEAD", "main");
    host.files.set("/repo/.capybara/skills/code-review/SKILL.md", skill("code-review", "native"));
    host.files.set("/repo/team-skills/code-review/SKILL.md", skill("code-review", "explicit"));
    const { discovery } = service(host);
    const snapshot = await discovery.discover(input(host, {
      ...defaultConfig().skills,
      paths: ["team-skills"],
    }));
    const winner = snapshot.accepted.find((definition) => definition.manifest.name === "code-review");
    expect(winner?.manifest.description).toBe("explicit");
    expect(winner?.origin).toBe("explicit");
    expect(snapshot.shadowed.filter((record) => record.name === "code-review")).toHaveLength(2);
  });
});

describe("Skills Discovery v2 reload snapshots", () => {
  test("add/delete reloads atomically and identical scans keep a stable digest", async () => {
    const host = memoryHost();
    host.files.set("/repo/.git/HEAD", "main");
    const alpha = "/repo/.capybara/skills/alpha/SKILL.md";
    const beta = "/repo/.capybara/skills/beta/SKILL.md";
    host.files.set(alpha, skill("alpha"));
    const { discovery, registry } = service(host);
    const first = await discovery.discover(input(host));
    const repeated = await discovery.reload(input(host));
    expect(repeated.digest).toBe(first.digest);
    expect(repeated.revision).toBe(first.revision + 1);

    host.files.delete(alpha);
    host.files.set(beta, skill("beta"));
    const changed = await discovery.reload(input(host));
    expect(registry.get("alpha")).toBeUndefined();
    expect(registry.get("beta")).toBeDefined();
    expect(changed.digest).not.toBe(first.digest);
  });

  test("produces the same digest across 100 identical filesystem scans", async () => {
    const host = memoryHost();
    host.files.set("/repo/.git/HEAD", "main");
    host.files.set("/repo/.capybara/skills/alpha/SKILL.md", skill("alpha"));
    host.files.set("/home/me/.agents/skills/beta/SKILL.md", skill("beta"));
    const { discovery } = service(host);
    const first = await discovery.discover(input(host));
    for (let iteration = 0; iteration < 100; iteration += 1) {
      expect((await discovery.reload(input(host))).digest).toBe(first.digest);
    }
  });

  test("retains the active snapshot when a reload scan is incomplete", async () => {
    const host = memoryHost();
    host.files.set("/repo/.git/HEAD", "main");
    const root = "/repo/.capybara/skills";
    host.files.set(`${root}/alpha/SKILL.md`, skill("alpha"));
    const { discovery, registry } = service(host);
    const first = await discovery.discover(input(host));

    host.failLists.add(root);
    const failed = await discovery.reload(input(host));
    expect(failed.applied).toBe(false);
    expect(failed.revision).toBe(first.revision);
    expect(failed.digest).toBe(first.digest);
    expect(registry.get("alpha")).toBeDefined();
    expect(failed.rejected.some((issue) => issue.field === "reload")).toBe(true);
  });
});
