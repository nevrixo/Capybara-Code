import { describe, expect, test } from "bun:test";
import {
  renderContextUsage,
  renderStyledInspection,
  formatTokens,
  formatBytes,
  lineText,
  type BlockContext,
} from "../src/index.ts";
import type { ContextUsageSnapshot } from "@cbc/session-domain";

const unicodeContext: BlockContext = {
  columns: 100,
  capabilities: { unicode: true, italic: false, reducedMotion: true },
};

const narrowContext: BlockContext = {
  columns: 50,
  capabilities: { unicode: true, italic: false, reducedMotion: true },
};

const asciiContext: BlockContext = {
  columns: 100,
  capabilities: { unicode: false, italic: false, reducedMotion: true },
};

const sampleSnapshot: ContextUsageSnapshot = {
  packId: "pack-1",
  modelId: "gpt-5.6-luna",
  budgetTokens: 272_000,
  modelWindowTokens: 400_000,
  outputReserveTokens: 32_000,
  optimizationTargetTokens: 20_000,
  usedTokens: 29_900,
  freeTokens: 242_100,
  overageTokens: 0,
  cachedInputTokens: 1_200,
  source: "provider_reconciled",
  capturedAt: "2026-08-21T00:00:00.000Z",
  categories: {
    system_prompt: 556,
    system_tools: 893,
    tool_io: 9_480,
    messages: 18_971,
  },
};

describe("renderContextUsage", () => {
  test("renders empty state gracefully when snapshot is undefined", () => {
    const lines = renderContextUsage(undefined, unicodeContext);
    const text = lines.map(lineText).join("\n");
    expect(text).toContain("Context Usage");
    expect(text).toContain("No compiled request yet");
  });

  test("renders Claude Code-style header, tree branches, and metrics", () => {
    const lines = renderContextUsage(sampleSnapshot, unicodeContext);
    const text = lines.map(lineText).join("\n");

    expect(text).toContain("Context Usage");
    expect(text).toContain("29.9k/272.0k tokens");
    expect(text).toContain("11.0%");
    expect(text).toContain("gpt-5.6-luna");
    expect(text).toContain("window 400.0k");
    expect(text).toContain("reserve 32.0k");
    expect(text).toContain("provider-reconciled");
    expect(text).toContain("Soft target 29.9k/20.0k");
    expect(text).toContain("exceeded (optimization only)");
  });

  test("renders side-by-side grid and legend in wide terminals", () => {
    const lines = renderContextUsage(sampleSnapshot, unicodeContext);
    const text = lines.map(lineText).join("\n");

    // Grid glyphs and Legend items should be on the same lines
    expect(text).toContain("System prompt: 556 tokens");
    expect(text).toContain("System tools: 893 tokens");
    expect(text).toContain("Tool use & results: 9.5k tokens");
    expect(text).toContain("Messages: 19.0k tokens");
    expect(text).toContain("Free space: 242.1k tokens");
    expect(text).toContain("Reserved: 32.0k tokens [output reserve]");
    expect(text).toContain("Cached input: 1.2k tokens");
  });

  test("supports ASCII fallback when terminal does not support unicode", () => {
    const lines = renderContextUsage(sampleSnapshot, asciiContext);
    const text = lines.map(lineText).join("\n");

    expect(text).toContain("Context Usage");
    expect(text).toContain("System prompt: 556 tokens");
  });

  test("falls back to stacked layout on narrow screens (< 56 cols)", () => {
    const lines = renderContextUsage(sampleSnapshot, narrowContext);
    const text = lines.map(lineText).join("\n");

    expect(text).toContain("Context Usage");
    expect(text).toContain("System prompt: 556 tokens");
    expect(text).toContain("Messages: 19.0k tokens");
  });

  test("renders styled inspection tree properly", () => {
    const inspection = {
      layers: [
        { layer: "L0_policy", estimatedTokens: 1056, detail: "root operating contract" },
        { layer: "L1_tool_semantics", estimatedTokens: 3439, detail: "17 active tool schema(s)" },
        { layer: "L2_project_instructions", estimatedTokens: 0, detail: "none loaded" },
      ],
      skills: [
        { name: "code-review", version: "1.0.0", source: "builtin" },
        { name: "commit-message", version: "1.0.0", source: "builtin" },
      ],
      reasoning: { items: 25, note: "never displayed" },
      cachePrefixFingerprint: "3ce65b49b80a7fcf",
      excludedLargeOutputs: [
        { label: "image_generation", bytes: 2_196_699, artifactId: "art_cce3c0" },
      ],
    };

    const lines = renderContextUsage(sampleSnapshot, unicodeContext, { inspection });
    const text = lines.map(lineText).join("\n");

    expect(text).toContain("Layers · 4.5k tokens estimated");
    expect(text).toContain("L0 policy");
    expect(text).toContain("1.1k tokens");
    expect(text).toContain("L1 tool semantics");
    expect(text).toContain("Skills · 2 available");
    expect(text).toContain("code-review v1.0.0 [builtin]");
    expect(text).toContain("Reasoning & Cache");
    expect(text).toContain("Reasoning items: 25");
    expect(text).toContain("Cache prefix: 3ce65b49b80a7fcf");
    expect(text).toContain("Excluded Large Outputs · 1 item(s)");
    expect(text).toContain("image_generation (2.1 MB) → art_cce3c0");
  });
});

describe("helpers", () => {
  test("formatTokens formats accurately", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(556)).toBe("556");
    expect(formatTokens(1250)).toBe("1.3k");
    expect(formatTokens(29900)).toBe("29.9k");
    expect(formatTokens(272000)).toBe("272.0k");
  });

  test("formatBytes formats accurately", () => {
    expect(formatBytes(500)).toBe("500 bytes");
    expect(formatBytes(1024 * 5)).toBe("5.0 KB");
    expect(formatBytes(1024 * 1024 * 2.5)).toBe("2.5 MB");
  });
});
