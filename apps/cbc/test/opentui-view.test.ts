import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { BoxRenderable, StyledText, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { line, segment, Theme } from "@cbc/tui-components";
import { OpenTuiView, toOpenTuiChunks } from "../src/opentui-view.ts";
import { withRowRevisions } from "../src/tui-frame.ts";

describe("OpenTUI view adapter", () => {
  test("renders Capybara semantic lines through the native OpenTUI renderer", async () => {
    const setup = await createTestRenderer({ width: 44, height: 4 });
    const theme = new Theme({ depth: "truecolor" });
    const root = new BoxRenderable(setup.renderer, {
      width: "100%",
      height: "100%",
      backgroundColor: theme.hex("bg.base"),
    });
    const content = new TextRenderable(setup.renderer, {
      width: "100%",
      height: "100%",
      wrapMode: "none",
      content: "",
    });
    content.content = new StyledText(
      toOpenTuiChunks(
        [
          line("header", [segment("capy /model", { fg: "accent.coral", bold: true })], "bg.panel"),
          line("status", [segment("ready", { fg: "accent.green" })]),
        ],
        theme,
      ),
    );
    root.add(content);
    setup.renderer.root.add(root);

    try {
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("capy /model");
      expect(frame).toContain("ready");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("allows an inert input stream to be injected for renderer tests", async () => {
    const realStdinListeners = process.stdin.listenerCount("data");
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    const stdout = Object.assign(new PassThrough(), {
      columns: 44,
      rows: 8,
      isTTY: true,
    }) as unknown as NodeJS.WriteStream;
    const view = await OpenTuiView.create({
      theme: new Theme({ depth: "truecolor" }),
      stdin,
      stdout,
    });

    try {
      expect(stdin.listenerCount("data")).toBe(0);
      expect(process.stdin.listenerCount("data")).toBe(realStdinListeners);
      expect(view.columns).toBe(44);
      expect(view.rows).toBe(8);

      view.suspend();
      view.resume();
      expect(stdin.listenerCount("data")).toBe(0);
      expect(view.rows).toBe(8);
    } finally {
      view.destroy();
      (stdin as unknown as PassThrough).destroy();
      stdout.destroy();
    }
  });

  test("forgets its row caches on resume so an unchanged frame still repaints", async () => {
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    const stdout = Object.assign(new PassThrough(), {
      columns: 44,
      rows: 8,
      isTTY: true,
    }) as unknown as NodeJS.WriteStream;
    const view = await OpenTuiView.create({
      theme: new Theme({ depth: "truecolor" }),
      stdin,
      stdout,
    });

    // A `user.ask` card that opens while a native prompt owns the terminal is
    // the real case: `withExternalPrompt` suspends the renderer, the prompt
    // overwrites the alternate screen, and the forced repaint afterwards can
    // submit a frame byte-identical to the pre-prompt one. The row caches
    // describe what the terminal *was* showing, so if they survive the handoff
    // every row is skipped as already-correct and the card stays invisible
    // until an unrelated keystroke happens to dirty a row.
    const frame = withRowRevisions([
      line("header", [segment("history", { fg: "fg.primary" })]),
      line("approval", [segment("  ?  Question", { fg: "accent.cyan" })]),
      line("approval", [segment("  > 1. Option A", { fg: "fg.primary" })]),
    ]);
    const contents = (): readonly unknown[] => view.paintedRowContents;

    try {
      view.render(frame);
      const painted = contents();
      expect(painted).toHaveLength(3);

      // With warm caches the same frame is correctly suppressed.
      view.render(frame);
      expect(contents()).toEqual(painted);

      view.suspend();
      view.resume();

      // After the handoff the identical frame must be painted again.
      view.render(frame);
      const repainted = contents();
      expect(repainted).toHaveLength(3);
      for (const [index, content] of repainted.entries()) {
        expect(content).not.toBe(painted[index]);
      }
    } finally {
      view.destroy();
      (stdin as unknown as PassThrough).destroy();
      stdout.destroy();
    }
  });
});
