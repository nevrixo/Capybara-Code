import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import { EventSequencer, createEvent, type CbcEventKind } from "@cbc/protocol";

import {
  buildCompactionSourceBundle,
  emptyViewModel,
  reduce,
  type CompactionReflection,
} from "../src/index.ts";

interface MeaningFixture {
  readonly name: string;
  readonly events: readonly {
    readonly kind: string;
    readonly payload: unknown;
  }[];
  readonly reflections?: readonly CompactionReflection[];
  readonly expect: {
    readonly goal?: string;
    readonly constraintCount?: number;
    readonly verificationCommands?: readonly string[];
    readonly excludedVerificationCommands?: readonly string[];
    readonly failureCorrection?: string;
    readonly artifact?: string;
    readonly path?: string;
    readonly fileSummary?: string;
    readonly todoId?: string;
    readonly todoStatus?: string;
    readonly blockedReason?: string;
    readonly approvalId?: string;
    readonly approvalStatus?: string;
    readonly decisionContains?: string;
  };
}

const fixturePath = resolve(
  process.cwd(),
  "fixtures/compaction-v2/meaning-preservation.json",
);
const fixtures = JSON.parse(readFileSync(fixturePath, "utf8")) as MeaningFixture[];

describe("context compaction meaning-preservation fixtures", () => {
  for (const fixture of fixtures) {
    test(fixture.name, () => {
      const sequencer = new EventSequencer();
      let model = emptyViewModel(`eval-${fixture.name.replace(/[^a-z0-9]+/giu, "-")}`);
      for (const entry of fixture.events) {
        model = reduce(model, createEvent(
          sequencer,
          entry.kind as CbcEventKind,
          entry.payload,
          { sessionId: model.sessionId },
        ));
      }
      const bundle = buildCompactionSourceBundle(model, {
        ...(fixture.reflections === undefined
          ? {}
          : { reflections: fixture.reflections }),
      });
      const expected = fixture.expect;
      if (expected.goal !== undefined) {
        expect(bundle.currentGoal?.goal).toBe(expected.goal);
      }
      if (expected.constraintCount !== undefined) {
        expect(bundle.userConstraints).toHaveLength(expected.constraintCount);
        expect(bundle.userConstraints.every((constraint) =>
          constraint.evidenceRefs.length > 0)).toBe(true);
      }
      if (expected.verificationCommands !== undefined) {
        expect(bundle.verification.map((check) => check.command)).toEqual(
          expect.arrayContaining(expected.verificationCommands),
        );
      }
      for (const excluded of expected.excludedVerificationCommands ?? []) {
        expect(bundle.verification.some((check) => check.command === excluded)).toBe(false);
      }
      if (expected.failureCorrection !== undefined) {
        expect(bundle.failures.some((failure) =>
          failure.correctiveAction === expected.failureCorrection)).toBe(true);
      }
      if (expected.artifact !== undefined) {
        expect(bundle.evidenceCatalog).toContainEqual({
          id: expected.artifact,
          kind: "artifact",
        });
      }
      if (expected.path !== undefined) {
        expect(bundle.changedFiles).toContainEqual(expect.objectContaining({
          path: expected.path,
          ...(expected.fileSummary === undefined
            ? {}
            : { diffSummary: expected.fileSummary }),
        }));
      }
      if (expected.todoId !== undefined) {
        expect(bundle.todos).toContainEqual(expect.objectContaining({
          id: expected.todoId,
          ...(expected.todoStatus === undefined
            ? {}
            : { status: expected.todoStatus }),
          ...(expected.blockedReason === undefined
            ? {}
            : { blockedReason: expected.blockedReason }),
        }));
      }
      if (expected.approvalId !== undefined) {
        expect(bundle.approvals).toContainEqual(expect.objectContaining({
          id: expected.approvalId,
          ...(expected.approvalStatus === undefined
            ? {}
            : { status: expected.approvalStatus }),
        }));
      }
      if (expected.decisionContains !== undefined) {
        expect(bundle.decisions.some((decision) =>
          decision.text.includes(expected.decisionContains!))).toBe(true);
      }
      expect(bundle.sourceDigest).toMatch(/^[a-f0-9]{64}$/u);
    });
  }

  test("fixture coverage remains aligned with the PRD minimum set", () => {
    expect(fixtures).toHaveLength(8);
  });
});
