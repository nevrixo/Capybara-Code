import { describe, expect, test } from "bun:test";

import type { ProposedAction } from "@cbc/permissions";
import { planVerification } from "@cbc/agent-kernel";

import { RuntimeToolExecutor } from "../src/tools.ts";
import {
  classifyVerificationAction,
  parseVerificationContract,
  verificationContractFromEnvironment,
} from "../src/verification-contract.ts";

const contract = parseVerificationContract({
  source: "pier",
  requiredCommands: ["go test ./..."],
  diagnosticCommands: ["go vet ./..."],
});

function processAction(callId: string, program: string, args: string[]): ProposedAction {
  return {
    callId,
    toolId: "process.run",
    arguments: { program, args, cwd: ".", timeoutMs: 1_000, maxOutputBytes: 4_096 },
    command: { program, args, cwd: ".", rawShell: false },
    display: [program, ...args].join(" "),
  };
}

describe("runner verification contract", () => {
  test("parses only a bounded valid environment contract", () => {
    expect(verificationContractFromEnvironment({
      CBC_VERIFICATION_CONTRACT: JSON.stringify({
        source: "pier",
        requiredCommands: ["go test ./..."],
        diagnosticCommands: [],
      }),
    })).toMatchObject({ source: "pier", requiredCommands: ["go test ./..."] });
    expect(verificationContractFromEnvironment({ CBC_VERIFICATION_CONTRACT: "not json" })).toBeUndefined();
    expect(parseVerificationContract({ source: "unknown", requiredCommands: ["go test ./..."] })).toBeUndefined();
  });

  test("keeps an explicit empty contract from falling back to a guessed runner", () => {
    const noCommandContract = parseVerificationContract({
      source: "detected",
      requiredCommands: [],
      diagnosticCommands: [],
      enforceOnly: true,
    });
    if (noCommandContract === undefined) throw new Error("empty strict contract did not parse");

    expect(classifyVerificationAction(noCommandContract, processAction("guessed", "bun", ["test"]))).toBe("off_contract");
    const steps = planVerification({
      changedPaths: ["pkg/example.go"],
      requiredCommands: noCommandContract.requiredCommands.map((command) => ({ command, reason: "runner contract" })),
      testCommandFor: () => ({ command: "go test ./...", reason: "heuristic" }),
      autoReview: false,
    });
    expect(steps.some((step) => step.kind === "closest_tests")).toBeFalse();
  });

  test("distinguishes required, diagnostic, and guessed test runners", () => {
    expect(contract).toBeDefined();
    expect(classifyVerificationAction(contract, processAction("required", "go", ["test", "./..."]))).toBe("required");
    expect(classifyVerificationAction(contract, processAction("diagnostic", "go", ["vet", "./..."]))).toBe("diagnostic");
    expect(classifyVerificationAction(contract, processAction("guessed", "bun", ["test"]))).toBe("off_contract");
    expect(classifyVerificationAction(contract, processAction("build", "go", ["build", "./..."]))).toBe("not_verification");
  });

  test("blocks an off-contract runner before calling the runtime", async () => {
    if (contract === undefined) throw new Error("test contract did not parse");
    let runtimeCalls = 0;
    const executor = new RuntimeToolExecutor({
      runtime: {
        workspace: "/work",
        run: async () => {
          runtimeCalls += 1;
          throw new Error("must not run");
        },
      } as never,
      host: { now: () => 1 } as never,
      verificationContract: contract,
    });

    const execution = await executor.execute(
      processAction("off-contract", "bun", ["test"]),
      new AbortController().signal,
    );

    expect(runtimeCalls).toBe(0);
    expect(execution.result.error?.code).toBe("OFF_CONTRACT_VERIFICATION");
    expect(execution.result.error?.details).toMatchObject({ command: "bun test", source: "pier" });
  });
});
