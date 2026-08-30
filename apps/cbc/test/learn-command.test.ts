/**
 * §6.3 `/learn` routing and verb behaviour (P1-01).
 *
 * The command is thin on purpose — every gate it appears to enforce is enforced
 * in CapsuleStore — so these tests pin two things: that the verbs reach the
 * store, and that the refusals the store produces reach the user as text rather
 * than as a thrown turn.
 */

import { describe, expect, test } from "bun:test";

import type { MemoryEvidence } from "@cbc/context-engine";
import { MemoryService } from "@cbc/memory-service";

import { applyLearnRequest, normalizeCapsuleId } from "../src/commands/learn.ts";
import { parseSlash, SLASH_COMMANDS } from "../src/slash.ts";
import { parseArgs } from "../src/args.ts";

function serviceFixture(policy: "off" | "suggest" | "on" = "suggest") {
  const evidence = new Map<string, MemoryEvidence>();
  const service = new MemoryService({
    resolveEvidence: (id) => evidence.get(id),
    workspaceIdentity: "workspace-a",
    capsulePolicy: policy,
    minVerifiedObservations: 2,
    now: () => "2026-01-01T00:00:00.000Z",
  });
  return service;
}

function proposeTwice(service: MemoryService, scope: "session" | "workspace" | "user" = "workspace") {
  const base = {
    kind: "workflow" as const,
    statement: "run bun run typecheck before claiming a change compiles",
    scope,
    confidence: 0.9,
    invalidators: ["toolset changed"],
  };
  service.proposeCapsule({ ...base, evidenceIds: ["ev-1"], routeIds: ["route-1"] });
  const second = service.proposeCapsule({ ...base, evidenceIds: ["ev-2"], routeIds: ["route-2"] });
  if (!second.accepted) throw new Error("fixture proposal was rejected");
  return second.capsule;
}

describe("/learn routing (§6.3)", () => {
  test("the command table advertises every §6.3 verb", () => {
    const learn = SLASH_COMMANDS.find((command) => command.name === "/learn");
    expect(learn).toBeDefined();
    expect(learn?.args?.[0]?.values).toEqual(["review", "accept", "reject", "forget", "rollback"]);
  });

  test("each verb parses to the learn intent, and a bare /learn defaults to review", () => {
    for (const action of ["review", "accept", "reject", "forget", "rollback"] as const) {
      expect(parseSlash(`/learn ${action} capsule-abc`)).toEqual({
        kind: "learn",
        action,
        argument: "capsule-abc",
      });
    }
    expect(parseSlash("/learn")).toEqual({ kind: "learn" });
    expect(parseSlash("/learn review")).toEqual({ kind: "learn", action: "review" });
  });

  test("an unrecognized verb is carried as an argument rather than silently dropped", () => {
    expect(parseSlash("/learn promote capsule-abc")).toEqual({
      kind: "learn",
      argument: "promote capsule-abc",
    });
  });

  test("the headless command parses the same verbs", () => {
    expect(parseArgs(["learn", "review"]).command).toEqual({ kind: "learn", sub: "review" });
    expect(parseArgs(["learn", "accept", "capsule-abc"]).command).toEqual({
      kind: "learn",
      sub: "accept",
      capsuleId: "capsule-abc",
    });
  });

  test("a bare digest is accepted in place of a full capsule id", () => {
    expect(normalizeCapsuleId("abc123")).toBe("capsule-abc123");
    expect(normalizeCapsuleId("capsule-abc123")).toBe("capsule-abc123");
  });
});

describe("/learn verbs against the capsule store (§6.3, §6.4)", () => {
  test("review reports the policy, the threshold, and why a capsule is proposed", () => {
    const service = serviceFixture();
    proposeTwice(service);

    const outcome = applyLearnRequest(service, { action: "review" });
    expect(outcome.ok).toBe(true);
    const text = outcome.lines.join("\n");
    expect(text).toContain("policy suggest");
    expect(text).toContain("2 verified observations required");
    expect(text).toContain("[proposed/workspace]");
    expect(text).toContain("2 observation(s)");
    expect(text).toContain("invalidated by: toolset changed");
  });

  test("accept is the user approval a workspace capsule needs", () => {
    const service = serviceFixture();
    const capsule = proposeTwice(service, "workspace");

    const outcome = applyLearnRequest(service, { action: "accept", argument: capsule.id });
    expect(outcome.ok).toBe(true);
    expect(outcome.lines.join("\n")).toContain("Activated");
    expect(service.recallCapsules()).toHaveLength(1);
  });

  test("accept below the observation threshold is refused with the reason", () => {
    const service = serviceFixture();
    const first = service.proposeCapsule({
      kind: "invariant",
      statement: "the runtime binary is built by scripts/build-runtime.ts",
      scope: "workspace",
      confidence: 0.8,
      evidenceIds: ["ev-1"],
      routeIds: ["route-1"],
    });
    expect(first.accepted).toBe(true);
    if (!first.accepted) return;

    const outcome = applyLearnRequest(service, { action: "accept", argument: first.capsule.id });
    expect(outcome.ok).toBe(false);
    expect(outcome.lines.join("\n")).toContain("independent verified observations");
    expect(service.recallCapsules()).toEqual([]);
  });

  test("reject and forget both take the capsule out of recall", () => {
    const service = serviceFixture();
    const rejected = proposeTwice(service, "session");
    expect(applyLearnRequest(service, { action: "reject", argument: rejected.id }).ok).toBe(true);
    expect(service.capsule(rejected.id)?.status).toBe("forgotten");

    const kept = serviceFixture();
    const capsule = proposeTwice(kept, "workspace");
    applyLearnRequest(kept, { action: "accept", argument: capsule.id });
    expect(kept.recallCapsules()).toHaveLength(1);
    expect(applyLearnRequest(kept, { action: "forget", argument: capsule.id }).ok).toBe(true);
    expect(kept.recallCapsules()).toEqual([]);
    expect(kept.auditCapsules().forgottenIds).toEqual([capsule.id]);
  });

  test("rollback restores the previous revision without re-asserting active", () => {
    const service = serviceFixture();
    const capsule = proposeTwice(service, "workspace");
    applyLearnRequest(service, { action: "accept", argument: capsule.id });
    service.amendCapsule(capsule.id, { invalidators: ["Cargo.lock changed"] });

    const outcome = applyLearnRequest(service, { action: "rollback", argument: capsule.id });
    expect(outcome.ok).toBe(true);
    expect(service.capsule(capsule.id)?.invalidators).toEqual(["toolset changed"]);
    expect(service.capsule(capsule.id)?.status).toBe("proposed");
    expect(service.recallCapsules()).toEqual([]);
  });

  test("a verb without an id explains itself instead of throwing", () => {
    const service = serviceFixture();
    const outcome = applyLearnRequest(service, { action: "accept" });
    expect(outcome.ok).toBe(false);
    expect(outcome.lines.join("\n")).toContain("needs a capsule id");
  });

  test("an unknown capsule id is reported, not thrown", () => {
    const service = serviceFixture();
    const outcome = applyLearnRequest(service, { action: "forget", argument: "capsule-missing" });
    expect(outcome.ok).toBe(false);
    expect(outcome.lines.join("\n")).toContain("unknown strategy capsule");
  });

  test("a disabled policy means there is nothing to review", () => {
    const service = serviceFixture("off");
    expect(() => proposeTwice(service)).toThrow(/rejected/);
    const outcome = applyLearnRequest(service, { action: "review" });
    expect(outcome.lines.join("\n")).toContain("No strategy capsules");
  });
});
