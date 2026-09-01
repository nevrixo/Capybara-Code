import { describe, expect, test } from "bun:test";

import { classifyFailure } from "../src/index.ts";

describe("process recovery guidance", () => {
  test("a failed verification command remains repairable inside Plan scope", () => {
    const hint = classifyFailure({
      toolId: "process.run",
      code: "PROCESS_EXIT_NONZERO",
      message: "npm run build exited with 1",
      text: "TypeError: expected a route to exist",
    });

    expect(hint.category).toBe("logic_bug");
    expect(hint.guidance).toContain("fix the underlying code or configuration");
    expect(hint.guidance).toContain("rerun the exact command");
    expect(hint.guidance).toContain("does not put an approved command out of scope");
  });

  test("a timed-out preview server points to process.start without changing its command", () => {
    const hint = classifyFailure({
      toolId: "process.run",
      code: "TIMEOUT",
      message: "npm run dev exceeded 30 seconds",
      retryable: true,
    });

    expect(hint.category).toBe("environment_issue");
    expect(hint.retryable).toBe(true);
    expect(hint.guidance).toContain("tool.discover");
    expect(hint.guidance).toContain("process.start");
    expect(hint.guidance).toContain("exact same program, argv, and cwd");
  });
});
