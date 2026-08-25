import { describe, expect, test } from "bun:test";

import {
  assertNoAmbientAuthority,
  validateNarrowing,
  type EffectivePluginOperation,
} from "../src/index.ts";

function operation(): EffectivePluginOperation {
  return {
    workspaceRead: ["package.json", "src/**", "docs/**"],
    workspaceWrite: ["src/**"],
    credentialScopes: ["registry-token"],
    toolIds: ["fs.read", "fs.edit", "process.run"],
    contextCandidateIds: ["ctx_a", "ctx_b"],
    network: "allow",
    timeoutMs: 5_000,
    outputBytes: 8_192,
    maxNodes: 8,
    risk: "R2",
    sandbox: "standard",
  };
}

describe("plugin authority monotonicity", () => {
  test("accepts only a deterministic intersection with stricter bounds", () => {
    const result = validateNarrowing(operation(), {
      workspaceRead: ["src/**", "package.json"],
      workspaceWrite: [],
      credentialScopes: [],
      toolIds: ["fs.read"],
      contextCandidateIds: ["ctx_b"],
      network: "deny",
      timeoutMs: 1_000,
      outputBytes: 4_096,
      maxNodes: 2,
      riskFloor: "R4",
      sandbox: "strict",
    });

    expect(result).toMatchObject({
      ok: true,
      effective: {
        workspaceRead: ["package.json", "src/**"],
        workspaceWrite: [],
        credentialScopes: [],
        toolIds: ["fs.read"],
        contextCandidateIds: ["ctx_b"],
        network: "deny",
        timeoutMs: 1_000,
        outputBytes: 4_096,
        maxNodes: 2,
        risk: "R4",
        sandbox: "strict",
      },
    });
  });

  test("rejects every widening category atomically", () => {
    const result = validateNarrowing({
      ...operation(),
      network: "ask",
      sandbox: "strict",
      risk: "R3",
    }, {
      workspaceRead: ["src/**", "secrets/**"],
      workspaceWrite: ["src/**", "generated/**"],
      credentialScopes: ["registry-token", "production-token"],
      toolIds: ["fs.read", "new-tool"],
      contextCandidateIds: ["ctx_a", "ctx_c"],
      network: "allow",
      timeoutMs: 6_000,
      outputBytes: 8_193,
      maxNodes: 9,
      riskFloor: "R1",
      sandbox: "unrestricted",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("widening must not produce an effective operation");
    expect(result.violations.map((violation) => violation.field).sort()).toEqual([
      "contextCandidateIds",
      "credentialScopes",
      "maxNodes",
      "network",
      "outputBytes",
      "riskFloor",
      "sandbox",
      "timeoutMs",
      "toolIds",
      "workspaceRead",
      "workspaceWrite",
    ]);
  });

  test("rejects malformed set members and never mutates the host operation", () => {
    const original = operation();
    const result = validateNarrowing(original, {
      workspaceRead: ["src/**", "src/**"],
      toolIds: [""],
    });

    expect(result.ok).toBe(false);
    expect(original.workspaceRead).toEqual(["package.json", "src/**", "docs/**"]);
    expect(original.toolIds).toEqual(["fs.read", "fs.edit", "process.run"]);
  });

  test("rejects ambient network or extra host keys on the default isolate grant", () => {
    const empty = {
      workspaceRead: [],
      workspaceWrite: [],
      credentialScopes: [],
      toolIds: [],
      contextCandidateIds: [],
      network: "deny" as const,
      timeoutMs: 1_000,
      outputBytes: 1_024,
      maxNodes: 1,
      risk: "R0" as const,
      sandbox: "strict" as const,
    };
    expect(() => assertNoAmbientAuthority(empty)).not.toThrow();
    expect(() => assertNoAmbientAuthority({ ...empty, workspaceRead: ["src/**"] })).not.toThrow();
    expect(() => assertNoAmbientAuthority({ ...empty, network: "allow" })).toThrow(/network must be deny/);
    expect(() => assertNoAmbientAuthority({ ...empty, workspaceWrite: ["src/**"] })).toThrow(/workspace write/);
    expect(() => assertNoAmbientAuthority(empty, { fetch: () => undefined })).toThrow(/unexpected authority/);
  });
});
