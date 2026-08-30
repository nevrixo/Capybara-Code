/**
 * §9.3 program lane security matrix.
 *
 * Each case here is one row of the PRD's security test list. They are written
 * against the policy gate rather than a live provider because the gate is the
 * boundary: a forged tool name, a tampered lineage, a stale workspace digest, or
 * a reused epoch has to be refused before anything reaches an executor, and by
 * value rather than by trusting what the provider labelled the call.
 */

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_PROGRAM_POLICY,
  ProgrammaticToolLane,
  sanitizeProgramOutput,
  validateProgramEvidenceResult,
  validateProgramToolCall,
} from "../src/index.ts";

const EPOCH = "epoch-1-abc";
const CALLER = "program-1";
const WORKSPACE = "w".repeat(64);

const usage = { expectedCallerId: CALLER, expectedTaskEpochId: EPOCH };

function call(overrides: Record<string, unknown> = {}) {
  return {
    callId: "call-1",
    toolId: "fs.read",
    arguments: { path: "src/index.ts" },
    callerId: CALLER,
    taskEpochId: EPOCH,
    ...overrides,
  };
}

describe("a program cannot forge a mutation tool name", () => {
  test("a writer, process, or credential tool is refused outright", () => {
    for (const toolId of [
      "fs.write",
      "fs.apply_patch",
      "fs.delete",
      "fs.move",
      "process.run",
      "process.spawn",
      "auth.login",
      "credential.read",
      "package.install",
    ]) {
      const decision = validateProgramToolCall(call({ toolId }), DEFAULT_PROGRAM_POLICY, usage);
      expect(decision.allowed).toBe(false);
    }
  });

  test("a read-shaped alias of a writer is still refused", () => {
    // The gate matches the canonical allowlist by exact id, so a name that only
    // looks like a read cannot smuggle a mutation through.
    for (const toolId of ["fs.read_write", "fs.readAndPatch", "fs.read/../write", "FS.WRITE"]) {
      expect(validateProgramToolCall(call({ toolId }), DEFAULT_PROGRAM_POLICY, usage).allowed)
        .toBe(false);
    }
  });

  test("an unknown tool is refused rather than passed through", () => {
    const decision = validateProgramToolCall(
      call({ toolId: "totally.invented" }),
      DEFAULT_PROGRAM_POLICY,
      usage,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("unknown_tool");
  });

  test("a policy that names a mutation tool still cannot admit it", () => {
    // A caller-supplied allowlist narrows; it must never widen past the
    // canonical read-only set, or a misconfigured host would grant writes.
    const decision = validateProgramToolCall(
      call({ toolId: "fs.write" }),
      { ...DEFAULT_PROGRAM_POLICY, allowedToolIds: ["fs.write", "fs.read"] },
      usage,
    );
    expect(decision.allowed).toBe(false);
  });
});

describe("a program cannot tamper with its lineage", () => {
  test("a mismatched caller is refused", () => {
    const decision = validateProgramToolCall(
      call({ callerId: "another-program" }),
      DEFAULT_PROGRAM_POLICY,
      usage,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("lineage_mismatch");
  });

  test("a call from another epoch is refused", () => {
    const decision = validateProgramToolCall(
      call({ taskEpochId: "epoch-9-zzz" }),
      DEFAULT_PROGRAM_POLICY,
      usage,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("lineage_mismatch");
  });

  test("an absent caller or epoch is refused rather than defaulted", () => {
    expect(validateProgramToolCall(call({ callerId: "" }), DEFAULT_PROGRAM_POLICY, usage).allowed)
      .toBe(false);
    expect(validateProgramToolCall(call({ taskEpochId: "" }), DEFAULT_PROGRAM_POLICY, usage).allowed)
      .toBe(false);
  });

  test("the coordinator refuses a batch whose ancestry is incomplete", () => {
    const lane = new ProgrammaticToolLane();
    const result = lane.admit({
      programId: "prog-1",
      callerId: "",
      taskEpochId: EPOCH,
      calls: [call()],
    });
    expect(result.accepted).toBe(false);
    expect(result.state).toBe("denied");
  });

  test("duplicate call ids in one batch are refused", () => {
    const lane = new ProgrammaticToolLane();
    const result = lane.admit({
      programId: "prog-1",
      callerId: CALLER,
      taskEpochId: EPOCH,
      calls: [call(), call()],
    });
    expect(result.accepted).toBe(false);
  });
});

describe("evidence from another epoch or workspace is not accepted as fact", () => {
  const expected = { taskEpochId: EPOCH, workspaceIdentityDigest: WORKSPACE };

  function evidence(overrides: Record<string, unknown> = {}) {
    return {
      status: "complete",
      claims: [{ text: "the reducer handles the kind", evidenceIds: ["ev-1"] }],
      missing: [],
      diagnostics: [],
      taskEpochId: EPOCH,
      workspaceIdentityDigest: WORKSPACE,
      stats: { calls: 1, parallelPeak: 1, inputBytes: 10, outputBytes: 20 },
      ...overrides,
    };
  }

  test("a stale workspace digest is rejected", () => {
    const decision = validateProgramEvidenceResult(
      evidence({ workspaceIdentityDigest: "x".repeat(64) }),
      expected,
    );
    expect(decision.accepted).toBe(false);
  });

  test("a reused epoch identity is rejected", () => {
    const decision = validateProgramEvidenceResult(
      evidence({ taskEpochId: "epoch-9-zzz" }),
      expected,
    );
    expect(decision.accepted).toBe(false);
  });

  test("a result claiming no identity at all is rejected", () => {
    const bare = evidence();
    delete (bare as Record<string, unknown>).taskEpochId;
    delete (bare as Record<string, unknown>).workspaceIdentityDigest;
    expect(validateProgramEvidenceResult(bare, expected).accepted).toBe(false);
  });

  test("junk is rejected without throwing", () => {
    for (const value of [undefined, null, 42, "complete", [], {}]) {
      expect(validateProgramEvidenceResult(value, expected).accepted).toBe(false);
    }
  });
});

describe("program output cannot flood or smuggle control bytes", () => {
  test("output past the byte budget is truncated and says so", () => {
    const output = sanitizeProgramOutput("a".repeat(10_000), 512);
    expect(output.truncated).toBe(true);
    expect(output.bytes).toBeLessThanOrEqual(512);
  });

  test("terminal escapes and C0 bytes are stripped", () => {
    const raw = `before\u001b[31mred\u0007\u0000 after`;
    const output = sanitizeProgramOutput(raw, 4_096);
    expect(output.text).not.toContain("\u001b");
    expect(output.text).not.toContain("\u0007");
    expect(output.text).not.toContain("\u0000");
    expect(output.text).toContain("before");
    expect(output.text).toContain("after");
  });

  test("a bounded output is digest-identified so it cannot be swapped later", () => {
    const first = sanitizeProgramOutput("stable text", 4_096);
    const second = sanitizeProgramOutput("stable text", 4_096);
    const other = sanitizeProgramOutput("different text", 4_096);
    expect(first.digest).toBe(second.digest);
    expect(first.digest).not.toBe(other.digest);
  });

  test("a program declaring an oversized source is refused before execution", () => {
    const lane = new ProgrammaticToolLane();
    const result = lane.admit({
      programId: "prog-1",
      callerId: CALLER,
      taskEpochId: EPOCH,
      calls: [call()],
      sourceBytes: (DEFAULT_PROGRAM_POLICY.maxProgramBytes ?? 0) + 1,
    });
    expect(result.accepted).toBe(false);
  });

  test("a program past its wall-time budget is refused before execution", () => {
    const lane = new ProgrammaticToolLane();
    const result = lane.admit({
      programId: "prog-1",
      callerId: CALLER,
      taskEpochId: EPOCH,
      calls: [call()],
      elapsedMs: (DEFAULT_PROGRAM_POLICY.maxWallTimeMs ?? 0) + 1,
    });
    expect(result.accepted).toBe(false);
  });
});

describe("a program cannot spend past its call budget", () => {
  test("the batch is refused once prior usage has spent the budget", () => {
    const lane = new ProgrammaticToolLane({ maxToolCalls: 2 });
    const result = lane.admit({
      programId: "prog-1",
      callerId: CALLER,
      taskEpochId: EPOCH,
      calls: [call()],
      callsUsed: 2,
    });
    expect(result.accepted).toBe(false);
  });

  test("a negative or fractional prior usage is refused rather than trusted", () => {
    const lane = new ProgrammaticToolLane({ maxToolCalls: 8 });
    for (const callsUsed of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = lane.admit({
        programId: "prog-1",
        callerId: CALLER,
        taskEpochId: EPOCH,
        calls: [call()],
        callsUsed,
      });
      expect(result.accepted).toBe(false);
    }
  });

  test("loops stay disabled by default", () => {
    const lane = new ProgrammaticToolLane();
    const result = lane.admit({
      programId: "prog-1",
      callerId: CALLER,
      taskEpochId: EPOCH,
      calls: [call()],
      loopIterations: 1,
    });
    expect(result.accepted).toBe(false);
  });
});
