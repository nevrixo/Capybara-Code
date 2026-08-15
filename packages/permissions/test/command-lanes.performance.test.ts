import { describe, expect, test } from "bun:test";

import { classifyCommandLane, type CommandSpec } from "../src/classifier.ts";

function command(program: string, args: readonly string[], cwd = "C:\\repo"): CommandSpec {
  return { program, args, cwd };
}

describe("command execution lanes", () => {
  test("places fixed read-only commands in a non-exclusive read lane", () => {
    const lane = classifyCommandLane(command("git", ["status", "--short"]));
    expect(lane.kind).toBe("read");
    expect(lane.exclusive).toBe(false);
    expect(lane.reason).toBe("fixed read-only invocation");
  });

  test("gives independent Bun test targets distinct conflict keys", () => {
    const first = classifyCommandLane(command("bun", ["test", "packages/a/test/a.test.ts"]));
    const second = classifyCommandLane(command("bun", ["test", "packages/b/test/b.test.ts"]));

    expect(first.kind).toBe("test");
    expect(second.kind).toBe("test");
    expect(first.exclusive).toBe(false);
    expect(second.exclusive).toBe(false);
    expect(first.conflictKeys).not.toEqual(second.conflictKeys);
  });

  test("serializes test commands that share a build output directory", () => {
    const cargo = classifyCommandLane(command("cargo", ["test", "--package", "kernel"]));
    const dotnet = classifyCommandLane(command("dotnet", ["test", "Agent.Tests"]));

    expect(cargo).toMatchObject({ kind: "test", exclusive: true });
    expect(dotnet).toMatchObject({ kind: "test", exclusive: true });
    expect(cargo.conflictKeys[0]).toContain("shared-build");
    expect(dotnet.conflictKeys[0]).toContain("shared-build");
  });

  test("keeps explicit workspace writers in an exclusive mutation lane", () => {
    const lane = classifyCommandLane(command("npm", ["run", "format", "--", "--write"]));
    expect(lane).toMatchObject({
      kind: "mutation",
      exclusive: true,
      reason: "recognized workspace-mutating command",
    });
  });

  test("treats network and external side effects as exclusive external work", () => {
    const fetch = classifyCommandLane(command("curl", ["https://example.invalid/data"]));
    const publish = classifyCommandLane(command("npm", ["publish"]));

    expect(fetch).toMatchObject({ kind: "external", exclusive: true });
    expect(publish).toMatchObject({ kind: "external", exclusive: true });
  });

  test("uses a process barrier for inline code and unknown executables", () => {
    const inline = classifyCommandLane(command("node", ["--eval", "console.log('x')"]));
    const unknown = classifyCommandLane(command("mystery-tool", ["check"]));

    expect(inline).toMatchObject({ kind: "process", exclusive: true });
    expect(unknown).toMatchObject({ kind: "process", exclusive: true });
    expect(inline.conflictKeys[0]).toContain("barrier");
    expect(unknown.conflictKeys[0]).toContain("barrier");
  });
});
