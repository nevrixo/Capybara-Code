import { describe, expect, test } from "bun:test";

import {
  AppendableMarkdownSourceIndex,
  ProjectedTimeline,
  blockContext,
  lineText,
  measureAndTruncate,
  offsetForColumn,
  renderMarkdown,
  renderMarkdownSourceTail,
  resetWidthDiagnostics,
  stringWidth,
  widthDiagnostics,
} from "../src/index.ts";

function context(columns = 60) {
  return blockContext({
    colorDepth: "none",
    italic: true,
    unicode: true,
    stableEmojiWidth: true,
    reducedMotion: false,
    mouse: false,
    columns,
    rows: 24,
    hyperlinks: false,
  });
}

describe("TUI performance revision primitives", () => {
  test("width hot paths preserve Unicode correctness without grapheme arrays", () => {
    resetWidthDiagnostics();
    expect(stringWidth("plain ASCII label")).toBe(17);
    expect(stringWidth("한글")).toBe(4);
    expect(stringWidth("👍🏽🇰🇷👩‍💻")).toBe(6);
    expect(stringWidth("\u0000\u001b\u007f\n\t")).toBe(0);
    expect(widthDiagnostics().graphemeArrayAllocations).toBe(0);

    const result = measureAndTruncate("한글입니다", 5);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe("한글…");
    expect(result.width).toBe(5);
    expect(offsetForColumn("한글ab", 5)).toBe(3);
  });

  test("appendable Markdown agrees with whole-source rendering across chunk boundaries", () => {
    const raw = "# Heading\n\n```ts\nconst value = 1;\n```\n\nAfter";
    const source = new AppendableMarkdownSourceIndex();
    for (const chunk of ["# He", "ading\n\n`", "``ts\nconst ", "value = 1;\n`", "``\n\nAfter"]) {
      source.append(chunk);
    }

    const incremental = renderMarkdownSourceTail(source, context(), {}, 20).lines;
    const whole = renderMarkdown(raw, context(), {});
    expect(incremental.map(lineText)).toEqual(whole.map(lineText));
    expect(source.stats.sourceCharactersInspected).toBe(raw.length);
    expect(source.stats.fullTextCalls).toBe(0);
  });

  test("streaming projection uses source revisions rather than canonical fingerprints", () => {
    const item = {
      type: "commentary" as const,
      id: "streaming-commentary",
      sequence: 1,
      variant: "commentary" as const,
      text: "first",
    };
    const source = new AppendableMarkdownSourceIndex(["first"]);
    const projection = new ProjectedTimeline();
    projection.sync([], {});
    projection.syncStreamingViews([{
      id: item.id,
      item,
      revision: 1,
      sourceView: source,
    }]);
    source.append(" second");
    projection.syncStreamingViews([{
      id: item.id,
      item: { ...item, text: "first second" },
      revision: 2,
      sourceView: source,
    }]);

    expect(projection.stats.itemFingerprintsComputed).toBe(0);
    expect(projection.stats.streamingRevisionUpdates).toBe(2);
    expect(projection.projectedItems()[0]).toMatchObject({ text: "first second" });
  });
});
