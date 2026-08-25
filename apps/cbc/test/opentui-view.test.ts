import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { BoxRenderable, StyledText, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { line, segment, Theme } from "@cbc/tui-components";
import { OpenTuiView, toOpenTuiChunks } from "../src/opentui-view.ts";

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
});
