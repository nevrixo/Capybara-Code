import { describe, expect, test } from "bun:test";

import { EventSequencer, createEvent } from "@cbc/protocol";
import {
  compact,
  emptyViewModel,
  estimateTokens,
  reduce,
  renderCompactState,
} from "../src/index.ts";

describe("compaction capsules", () => {
  test("preserve TODO and exact evidence handles in a generation capsule", () => {
    const sequencer = new EventSequencer();
    let model = emptyViewModel("capsule");
    model = reduce(model, createEvent(sequencer, "user.message", { text: "implement parser" }, { sessionId: "capsule" }));
    model = reduce(model, createEvent(sequencer, "plan.created", {
      revision: 1,
      source: "model",
      items: [{ id: "impl", text: "implement parser", status: "active", kind: "implementation", files: ["src/parser.ts"] }],
    }, { sessionId: "capsule" }));
    model = reduce(model, createEvent(sequencer, "tool.started", {
      callId: "read-1",
      toolId: "fs.read",
      display: "src/parser.ts",
    }, { sessionId: "capsule" }));
    model = reduce(model, createEvent(sequencer, "tool.completed", {
      callId: "read-1",
      toolId: "fs.read",
      summary: "src/parser.ts inspected",
      artifacts: ["artifact-parser"],
    }, { sessionId: "capsule" }));

    const result = compact(model, "projected_pressure", estimateTokens, {
      targetTokens: 1_024,
      generation: 4,
      evidenceRefs: ["evidence-parser"],
    });

    expect(result.capsule.generation).toBe(4);
    expect(result.capsule.sourceRange.firstSequence).toBeGreaterThan(0);
    expect(result.capsule.digest).toHaveLength(64);
    expect(result.capsule.todoSnapshot).toMatchObject([{ id: "impl", status: "active" }]);
    expect(result.capsule.evidenceRefs).toEqual(["evidence-parser", "artifact-parser"]);
    expect(renderCompactState(result.state)).toContain("TODO snapshot");
    expect(result.journalPreserved).toBe(true);
  });
});
