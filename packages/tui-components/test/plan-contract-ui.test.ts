import { describe, expect, test } from "bun:test";

import {
  blockContext,
  computePlanReadiness,
  lineText,
  lineWidth,
  renderPlanApprovalPicker,
  renderPlanContract,
  renderPlanOverlay,
  renderPlanSummary,
  renderTodoList,
  renderTimeline,
  type TerminalCapabilities,
} from "../src/index.ts";
import { assessPlanReadiness, planDigest } from "@cbc/session-domain";

function context(columns = 80) {
  const capabilities: TerminalCapabilities = {
    colorDepth: "none",
    italic: false,
    unicode: true,
    stableEmojiWidth: true,
    reducedMotion: true,
    mouse: false,
    columns,
    rows: 24,
    hyperlinks: false,
  };
  return blockContext(capabilities, columns);
}

const document = {
  goal: "Make the parser deterministic",
  context: ["The parser is used by the CLI"],
  assumptions: ["No public command changes"],
  criticalFiles: [{ path: "src/parser.ts", symbols: ["parseInput"] }],
  verification: [{ command: "bun test", expectedResult: "all tests pass" }],
  externalActions: [{ server: "docs", tool: "publish", description: "only after approval" }],
  risks: ["A malformed token could regress completion"],
  rollback: ["revert the parser commit"],
} as const;

const items = [
  { id: "inspect", text: "Inspect the current parser", status: "done" as const, kind: "analysis" as const },
  {
    id: "implement",
    text: "Implement the parser change",
    status: "pending" as const,
    kind: "implementation" as const,
    files: ["src/parser.ts"],
    acceptanceCriteria: ["focused tests pass"],
  },
  { id: "verify", text: "Run verification", status: "pending" as const, kind: "verification" as const },
];

describe("Plan Contract UI", () => {
  test("does not treat supplemental implementation files as missing critical anchors", () => {
    const supplementalItems = items.map((item) => item.id === "implement"
      ? { ...item, files: ["src/parser.ts", "tsconfig.json", "vite.config.ts", "src/vite-env.d.ts"] }
      : item);

    const view = computePlanReadiness(document, supplementalItems);
    const domain = assessPlanReadiness(document, supplementalItems);

    expect(view).toMatchObject({ ready: true });
    expect(view.blockers ?? []).toEqual([]);
    expect(domain.ready).toBe(true);
    expect(domain.blockers).toEqual([]);
  });

  test("renders every contract section and execution metadata", () => {
    const lines = renderPlanContract({
      document,
      items,
      revision: 4,
      readiness: { ready: true, blockers: [], digest: planDigest(document, items)! },
      approval: {
        revision: 3,
        digest: planDigest(document, items)!,
        approvedAt: "2026-08-11T00:00:00.000Z",
        via: "slash",
        contextStrategy: "keep",
      },
    }, context());
    const text = lines.map(lineText).join("\n");
    for (const label of ["Goal", "Context", "Critical files & anchors", "Approach", "Verification", "External actions", "Risks", "Rollback"]) {
      expect(text).toContain(label);
    }
    expect(text).toMatch(/plan-sha256-[0-9a-f]{8}/u);
    expect(text).toContain("Approved");
  });

  test("keeps structured output inside narrow terminal width", () => {
    const lines = renderPlanContract({ document, items }, context(32));
    expect(lines.length).toBeGreaterThan(10);
    for (const row of lines) expect(lineWidth(row)).toBeLessThanOrEqual(32);
  });

  test("shows the unapproved contract digest in the focused picker", () => {
    const lines = renderPlanApprovalPicker({ document, items, revision: 4 }, context(), {
      choices: ["Approve", "Cancel"],
    });
    const text = lines.map(lineText).join("\n");
    expect(text).toContain("Digest:");
    expect(text).toMatch(/plan-sha256-[0-9a-f]{8}/u);
  });

  test("uses the session-domain digest rather than a lossy display projection", () => {
    const expected = planDigest(document, items)!;
    const lines = renderPlanApprovalPicker({ document, items, revision: 4 }, context(200), {
      choices: ["Approve", "Cancel"],
    });
    const text = lines.map(lineText).join("\n");
    expect(text).toContain(expected);
  });

  test("does not mark a changed contract approved from stale overlay metadata", () => {
    const lines = renderPlanContract({
      document,
      items,
      revision: 5,
      approval: { revision: 4, digest: "plan-sha256-stale" },
    }, context());
    const text = lines.map(lineText).join("\n");
    expect(text).not.toContain("plan-sha256-stale");
    expect(text).not.toContain("✓ Approved");
    expect(text).toContain("Ready for approval");
  });

  test("derives a digest for a document before approach items exist", () => {
    const lines = renderPlanApprovalPicker({ document, items: [], revision: 1 }, context(), {
      choices: ["Approve", "Cancel"],
    });
    const text = lines.map(lineText).join("\n");
    expect(text).toContain("Digest:");
    expect(text).toMatch(/plan-sha256-[0-9a-f]{8}/u);
  });

  test("does not display stale approval metadata as the current scope digest", () => {
    const lines = renderPlanApprovalPicker({
      document,
      items,
      revision: 5,
      approval: {
        revision: 4,
        digest: "plan-sha256-stale",
      },
    }, context(), { choices: ["Approve", "Cancel"] });
    const text = lines.map(lineText).join("\n");
    expect(text).not.toContain("plan-sha256-stale");
    expect(text).toMatch(/plan-sha256-[0-9a-f]{8}/u);
  });


  test("approved TODO overlay returns to the compact normal list", () => {
    const digest = planDigest(document, items);
    const lines = renderTodoList({
      document,
      items,
      revision: 4,
      updatedAt: "2026-08-11T00:00:00.000Z",
      approval: {
        revision: 4,
        digest: digest!,
        approvedAt: "2026-08-11T00:00:00.000Z",
        via: "slash",
        contextStrategy: "keep",
      },
      approvedRevision: 4,
    }, context());
    const text = lines.map(lineText).join("\n");
    expect(text).toContain("Todo");
    expect(text).not.toContain("r4");
    expect(text).toContain("Implement the parser change");
    expect(text).not.toContain("Goal");
    expect(text).not.toContain("Critical files & anchors");
  });

  test("shows an approved scope with blocked work as execution-blocked", () => {
    const blockedItems = items.map((item) => item.id === "implement"
      ? { ...item, status: "blocked" as const, blockedReason: "The execution environment denied the write" }
      : item);
    const digest = planDigest(document, blockedItems)!;
    const lines = renderTodoList({
      document,
      items: blockedItems,
      revision: 5,
      updatedAt: "2026-08-11T00:00:00.000Z",
      approval: {
        revision: 4,
        digest,
        approvedAt: "2026-08-11T00:00:00.000Z",
        via: "slash",
        contextStrategy: "keep",
      },
      approvedRevision: 4,
    }, context());
    const text = lines.map(lineText).join("\n");
    expect(text).toContain("Approved scope blocked");
    expect(text).toContain("blocked approach step exists");
    expect(text).toContain("Goal");
    expect(text).not.toContain("Approved revision 4");
  });

  test("timeline projects only the newest structured Plan snapshot", () => {
    const oldDocument = { ...document, goal: "Old plan goal" };
    const newDocument = { ...document, goal: "Current plan goal" };
    const lines = renderTimeline([
      { type: "plan", id: "plan-1", sequence: 1, document: oldDocument, items },
      { type: "plan", id: "plan-2", sequence: 2, document: newDocument, items },
    ], context());
    const text = lines.map(lineText).join("\n");
    expect(text).toContain("Current plan goal");
    expect(text).not.toContain("Old plan goal");
    expect((text.match(/Goal/g) ?? []).length).toBe(1);
  });

  test("approved timeline snapshot uses the compact TODO projection", () => {
    const digest = planDigest(document, items)!;
    const lines = renderTimeline([
      {
        type: "plan",
        id: "plan-approved",
        sequence: 1,
        document,
        items,
        approval: {
          revision: 4,
          digest,
          approvedAt: "2026-08-11T00:00:00.000Z",
          via: "slash",
          contextStrategy: "keep",
        },
      },
    ], context());
    const text = lines.map(lineText).join("\n");
    expect(text).toContain("Todo");
    expect(text).not.toContain("Goal");
    expect(text).not.toContain("Ready for approval");
  });

  test("frames the contract as a plan overlay", () => {
    const lines = renderPlanOverlay({ document, items }, context());
    const text = lines.map(lineText).join("\n");
    expect(text).toContain("Plan contract");
    expect(text).toContain("Goal");
    expect(text).toContain("esc to close");
  });

  test("an open analysis step does not hold back an otherwise complete plan", () => {
    // Same contract as `items`, but the model never ticked its own research step
    // off. That is not a defect in the plan, so it must not read as one: the
    // banner it used to produce said "analysis step is not complete", which the
    // user could not clear by editing any part of the contract.
    const openAnalysis = items.map((item) =>
      item.kind === "analysis" ? { ...item, status: "pending" as const } : item,
    );

    const view = computePlanReadiness(document, openAnalysis);
    expect(view.ready).toBe(true);
    expect(view.blockers ?? []).toEqual([]);

    // The session-domain gate is the authority for approval and must agree; a
    // split verdict would paint the plan approvable while refusing to run it.
    const domain = assessPlanReadiness(document, openAnalysis);
    expect(domain.ready).toBe(true);
    expect(domain.blockers).toEqual([]);
  });

  test("still reports the structural gaps that make a plan genuinely incomplete", () => {
    const gutted = computePlanReadiness(
      { ...document, context: [], criticalFiles: [], verification: [] },
      [{ id: "look", text: "Look around", status: "pending" as const, kind: "analysis" as const }],
    );
    expect(gutted.ready).toBe(false);
    expect(gutted.blockers).toContain("Context is missing");
    expect(gutted.blockers).toContain("Critical files are missing");
    expect(gutted.blockers).toContain("Verification is missing");
    expect(gutted.blockers).toContain("Approach has no implementation step");
    // A blocked step is still a real blocker — only the open-analysis gate went.
    const blocked = computePlanReadiness(document, [
      ...items,
      { id: "stuck", text: "Stuck", status: "blocked" as const, kind: "implementation" as const,
        files: ["src/parser.ts"], acceptanceCriteria: ["n/a"] },
    ]);
    expect(blocked.blockers).toContain("blocked approach step exists");
  });

  describe("collapsed timeline projection", () => {
    const CONTRACT_SECTIONS = [
      "Critical files & anchors",
      "Verification",
      "External actions",
      "Risks",
      "Rollback",
      "Assumptions",
    ] as const;

    function timelineText(
      overrides: Record<string, unknown> = {},
      options: Parameters<typeof renderTimeline>[2] = {},
      columns = 100,
    ): string {
      const lines = renderTimeline(
        [{ type: "plan", id: "plan-1", sequence: 1, document, items, revision: 3, ...overrides } as never],
        context(columns),
        options,
      );
      return lines.map(lineText).join("\n");
    }

    test("keeps the timeline to a summary instead of the whole contract", () => {
      const text = timelineText();
      // The contract body is what buried the conversation; it belongs in the overlay.
      for (const section of CONTRACT_SECTIONS) expect(text).not.toContain(section);
      expect(text.split("\n").length).toBeLessThan(8);
      expect(text).toContain("Goal: Make the parser deterministic");
      expect(text).toContain("Steps: 1/3 done");
    });

    test("points at the key that opens the full contract", () => {
      expect(timelineText()).toContain("Ctrl+X P");
    });

    test("shortens the digest but keeps it auditable", () => {
      const text = timelineText();
      expect(text).toMatch(/plan-sha256-[0-9a-f]{8}/u);
      // A 64-character hash spends a whole row saying what 8 characters already say.
      expect(text).not.toMatch(/[0-9a-f]{64}/u);
    });

    test("never hides why execution is blocked", () => {
      const blockedItems = items.map((item) =>
        item.kind === "implementation" ? { ...item, status: "blocked" as const } : item,
      );
      const text = timelineText({ items: blockedItems });
      expect(text).toContain("! Blocked");
      expect(text).toContain("blocker: blocked approach step exists");
      expect(text).toContain("1 blocked");
    });

    test("caps a long blocker list rather than growing without bound", () => {
      const text = timelineText({
        document: { ...document, context: [], criticalFiles: [], verification: [] },
        items: [],
      });
      expect((text.match(/blocker: /g) ?? []).length).toBe(2);
      expect(text).toMatch(/\+\d+ more blockers/u);
    });

    test("an approved digest keeps the existing compact TODO projection", () => {
      const blockedItems = items.map((item) =>
        item.kind === "implementation" ? { ...item, status: "blocked" as const } : item,
      );
      const text = timelineText({
        items: blockedItems,
        approval: { revision: 3, digest: planDigest(document, blockedItems)! },
      });
      expect(text).toContain("Todo 1/3 done");
      // The blocked step stays legible through its status box.
      expect(text).toContain("[!]");
    });

    test("an approved scope with blocked work does not read as approved", () => {
      // Direct call: the timeline's own approved-digest branch keeps the compact
      // TODO projection (asserted above), and the frame reports blocked execution
      // through the Plan controls. This pins the summary's own labelling, which is
      // what renders whenever a scope is not digest-approved.
      const blockedItems = items.map((item) =>
        item.kind === "implementation" ? { ...item, status: "blocked" as const } : item,
      );
      const text = renderPlanSummary({
        document,
        items: blockedItems,
        revision: 3,
        approval: { revision: 3, digest: planDigest(document, blockedItems)! },
      }, context()).map(lineText).join("\n");
      expect(text).toContain("! Approved scope blocked");
      expect(text).not.toContain("✓ Approved");
      expect(text).toContain("blocker: blocked approach step exists");
    });

    test("labels a ready and approved scope as approved", () => {
      const text = renderPlanSummary({
        document,
        items,
        revision: 4,
        approval: { revision: 4, digest: planDigest(document, items)! },
      }, context()).map(lineText).join("\n");
      expect(text).toContain("✓ Approved");
      expect(text).not.toContain("blocker:");
    });

    test("planDetail full restores the whole contract for review surfaces", () => {
      const text = timelineText({}, { planDetail: "full" });
      for (const section of CONTRACT_SECTIONS) expect(text).toContain(section);
    });

    test("stays inside a narrow terminal and keeps the hint on its own line", () => {
      const columns = 44;
      const lines = renderTimeline(
        [{ type: "plan", id: "plan-1", sequence: 1, document, items, revision: 3 } as never],
        context(columns),
      );
      for (const row of lines) expect(lineWidth(row)).toBeLessThanOrEqual(columns);
      const text = lines.map(lineText).join("\n");
      const hintRow = text.split("\n").find((row) => row.includes("Ctrl+X P"));
      expect(hintRow?.trim()).toBe("Ctrl+X P for full contract");
    });
  });
});
