import { describe, expect, test } from "bun:test";

import { emptyViewModel } from "@cbc/session-domain";
import type { InteractiveUi } from "../src/tui.ts";
import { InputReader } from "../src/input-reader.ts";
import type { KeyEvent, KeyStream } from "../src/keys.ts";
import { WorkspacePathMentionIndex } from "../src/path-mentions.ts";

class FakeKeyStream implements KeyStream {
  readonly active = true;
  running = false;
  private sink: ((event: KeyEvent) => void) | undefined;

  start(): void {
    this.running = true;
  }

  stop(): void {
    this.running = false;
    this.sink = undefined;
  }

  setSink(sink: ((event: KeyEvent) => void) | undefined): void {
    this.sink = sink;
  }

  emit(event: KeyEvent): void {
    this.sink?.(event);
  }
}

interface DrawnComposer {
  readonly text: string;
  readonly cursor: number;
}

function fakeUi(draws: DrawnComposer[]): InteractiveUi {
  const ui = {
    drawComposer: (state: DrawnComposer) => draws.push({ ...state }),
    eraseComposer: () => undefined,
    notice: () => undefined,
    toggleSidebar: () => false,
    scrollPageUp: () => undefined,
    scrollPageDown: () => undefined,
    readPrompt: async () => undefined,
  };
  return ui as unknown as InteractiveUi;
}

describe("input reader composer ownership", () => {
  test("keeps the composer visible and preserves a draft across a running turn", async () => {
    const keys = new FakeKeyStream();
    const draws: DrawnComposer[] = [];
    const reader = new InputReader({ keys, ui: fakeUi(draws) });
    reader.start();

    const firstPrompt = reader.readPrompt();
    keys.emit({ key: "text", text: "first" });
    keys.emit({ key: "enter" });
    expect(await firstPrompt).toBe("first");

    let releaseTurn!: () => void;
    const turn = reader.duringTurn(
      new AbortController(),
      { viewModel: emptyViewModel("session") },
      () => new Promise<void>((resolve) => {
        releaseTurn = resolve;
      }),
    );

    expect(draws.at(-1)?.text).toBe("");
    keys.emit({ key: "text", text: "draft" });
    expect(draws.at(-1)?.text).toBe("draft");

    releaseTurn();
    await turn;

    const nextPrompt = reader.readPrompt();
    expect(draws.at(-1)?.text).toBe("draft");
    keys.emit({ key: "enter" });
    expect(await nextPrompt).toBe("draft");
  });

  test("does not submit while an async Plan mode action is settling", async () => {
    const keys = new FakeKeyStream();
    const draws: DrawnComposer[] = [];
    let release!: (directive?: string) => void;
    const reader = new InputReader({
      keys,
      ui: fakeUi(draws),
      onCycleInteractionMode: () => new Promise<string | undefined>((resolve) => {
        release = resolve;
      }),
    });
    reader.start();

    const prompt = reader.readPrompt();
    keys.emit({ key: "shift+tab" });
    keys.emit({ key: "text", text: "raced" });
    keys.emit({ key: "enter" });
    let settled = false;
    void prompt.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    await Promise.resolve();
    keys.emit({ key: "text", text: "safe" });
    keys.emit({ key: "enter" });
    expect(await prompt).toBe("safe");
    reader.stop();
  });

  test("drafting slash input during a turn does not abort or settle the turn", async () => {
    const keys = new FakeKeyStream();
    const draws: DrawnComposer[] = [];
    const reader = new InputReader({ keys, ui: fakeUi(draws) });
    reader.start();

    const controller = new AbortController();
    let release!: () => void;
    let settled = false;
    const turn = reader
      .duringTurn(
        controller,
        { viewModel: emptyViewModel("session") },
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      )
      .then(() => {
        settled = true;
      });

    keys.emit({ key: "text", text: "/" });
    await Promise.resolve();

    expect(controller.signal.aborted).toBe(false);
    expect(settled).toBe(false);
    expect(draws.at(-1)?.text).toBe("/");

    release();
    await turn;
    reader.stop();
  });

  test("Ctrl+C Ctrl+C requests a full-program exit while a turn runs", async () => {
    const keys = new FakeKeyStream();
    const draws: DrawnComposer[] = [];
    const reader = new InputReader({ keys, ui: fakeUi(draws) });
    reader.start();

    const controller = new AbortController();
    let release!: () => void;
    const turn = reader.duringTurn(
      controller,
      { viewModel: emptyViewModel("session") },
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

    keys.emit({ key: "ctrl+c" });
    expect(controller.signal.aborted).toBe(false);
    expect(reader.takeExitRequested()).toBe(false);

    keys.emit({ key: "ctrl+c" });
    expect(controller.signal.aborted).toBe(true);
    expect(reader.takeExitRequested()).toBe(true);

    release();
    await turn;
    reader.stop();
  });

  test("Esc Esc stops a turn after interrupting a subagent wait", async () => {
    const keys = new FakeKeyStream();
    const draws: DrawnComposer[] = [];
    const reader = new InputReader({ keys, ui: fakeUi(draws) });
    reader.start();

    const controller = new AbortController();
    let awaitingTaskId: string | undefined = "agent_1";
    let release!: () => void;
    const turn = reader.duringTurn(
      controller,
      {
        get viewModel() {
          const base = emptyViewModel("session");
          return {
            ...base,
            ...(awaitingTaskId !== undefined ? { awaitingTaskId } : {}),
          };
        },
        interruptTaskWait: (taskId) => {
          if (taskId !== awaitingTaskId) return false;
          awaitingTaskId = undefined;
          return true;
        },
      },
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

    keys.emit({ key: "escape" });
    expect(controller.signal.aborted).toBe(false);

    keys.emit({ key: "escape" });
    expect(controller.signal.aborted).toBe(true);

    release();
    await turn;
    reader.stop();
  });

  test("Esc Esc cancels an idle background task", async () => {
    const keys = new FakeKeyStream();
    const draws: DrawnComposer[] = [];
    const cancelled: Array<{ taskId: string; reason: string | undefined }> = [];
    const reader = new InputReader({
      keys,
      ui: fakeUi(draws),
      activeTaskId: () => "agent_1",
      onCancelTask: async (taskId, reason) => {
        cancelled.push({ taskId, reason });
      },
    });
    reader.start();

    const prompt = reader.readPrompt();
    keys.emit({ key: "escape" });
    keys.emit({ key: "escape" });
    await Promise.resolve();

    expect(cancelled).toEqual([{ taskId: "agent_1", reason: "cancelled with Esc" }]);

    keys.emit({ key: "ctrl+c" });
    keys.emit({ key: "ctrl+c" });
    expect(await prompt).toBeUndefined();
    reader.stop();
  });
  test("accepts an @ file mention before submitting the prompt", async () => {
    const keys = new FakeKeyStream();
    const draws: DrawnComposer[] = [];
    const mentions = new WorkspacePathMentionIndex();
    mentions.replaceFiles([{ path: "src/main.ts" }, { path: "src/parser.ts" }]);
    const reader = new InputReader({
      keys,
      ui: fakeUi(draws),
      sources: { paths: (query) => mentions.candidates(query) },
    });
    reader.start();

    const prompt = reader.readPrompt();
    keys.emit({ key: "text", text: "inspect @main" });
    keys.emit({ key: "enter" });
    expect(draws.at(-1)?.text).toBe("inspect @src/main.ts ");

    keys.emit({ key: "enter" });
    expect(await prompt).toBe("inspect @src/main.ts");
    reader.stop();
  });

  test("a submit carries pasted text verbatim; no attachments are staged (P1-02)", async () => {
    const keys = new FakeKeyStream();
    const draws: DrawnComposer[] = [];
    const reader = new InputReader({ keys, ui: fakeUi(draws) });
    reader.start();

    const prompt = reader.readPrompt();
    // P1-02: paste tokenization is disabled until a real attachment pipeline
    // exists, so pastes reach the prompt (and the model) verbatim.
    keys.emit({ key: "paste", text: "first line\nsecond line" });
    keys.emit({ key: "paste", text: "/tmp/figure.png" });
    keys.emit({ key: "text", text: "describe" });
    keys.emit({ key: "enter" });

    expect(await prompt).toBe("first line\nsecond line/tmp/figure.pngdescribe");
    expect(reader.lastAttachments).toHaveLength(0);

    reader.stop();
  });

  test("can hand off an automatic idle action as the next directive", async () => {
    const keys = new FakeKeyStream();
    const draws: DrawnComposer[] = [];
    const reader = new InputReader({
      keys,
      ui: fakeUi(draws),
      onPromptReady: () => Promise.resolve("HOST EXECUTION DIRECTIVE"),
    });
    reader.start();

    expect(await reader.readPrompt()).toBe("HOST EXECUTION DIRECTIVE");
    reader.stop();
  });

  test("Esc does not end a prompt; Ctrl+C Ctrl+C does", async () => {
    const keys = new FakeKeyStream();
    const draws: DrawnComposer[] = [];
    const reader = new InputReader({ keys, ui: fakeUi(draws) });
    reader.start();

    const prompt = reader.readPrompt();
    let settled = false;
    void prompt.then(() => {
      settled = true;
    });

    keys.emit({ key: "escape" });
    keys.emit({ key: "escape" });
    await Promise.resolve();
    expect(settled).toBe(false);

    keys.emit({ key: "ctrl+c" });
    await Promise.resolve();
    expect(settled).toBe(false);

    keys.emit({ key: "ctrl+c" });
    expect(await prompt).toBeUndefined();
    reader.stop();
  });

  test("rechecks an idle Plan choice after its read-only overlay closes", async () => {

    const keys = new FakeKeyStream();
    const draws: DrawnComposer[] = [];
    const ui = fakeUi(draws) as unknown as {
      closeOverlay: () => "plan";
    };
    let overlayOpen = true;
    Object.defineProperty(ui, "overlayOpen", {
      configurable: true,
      get: () => overlayOpen,
    });
    ui.closeOverlay = () => {
      overlayOpen = false;
      return "plan";
    };
    let promptReadyCalls = 0;
    const reader = new InputReader({
      keys,
      ui: ui as unknown as InteractiveUi,
      onPromptReady: () => {
        promptReadyCalls += 1;
      },
    });
    reader.start();

    const prompt = reader.readPrompt();
    expect(promptReadyCalls).toBe(1);

    keys.emit({ key: "escape" });
    expect(promptReadyCalls).toBe(2);

    keys.emit({ key: "ctrl+c" });
    keys.emit({ key: "ctrl+c" });
    expect(await prompt).toBeUndefined();
    reader.stop();
  });
});
