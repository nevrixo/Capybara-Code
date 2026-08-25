import { describe, expect, test } from "bun:test";

import { emptyViewModel } from "@cbc/session-domain";
import { DEFAULT_KEYMAP, applyRemapping } from "@cbc/tui-components";
import { ComposerSession } from "../src/composer.ts";
import { InputReader } from "../src/input-reader.ts";
import { decodeKeys, type InputEvent, type KeyStream } from "../src/keys.ts";
import { LiveSpanRegistry } from "../src/live-spans.ts";
import type { InteractiveUi } from "../src/tui.ts";

const IDLE = { turnRunning: false } as const;

class TestKeyStream implements KeyStream {
  readonly active = true;
  running = false;
  #sink: ((event: InputEvent) => void) | undefined;

  start(): void { this.running = true; }
  stop(): void { this.running = false; this.#sink = undefined; }
  setSink(sink: ((event: InputEvent) => void) | undefined): void { this.#sink = sink; }
  emit(event: InputEvent): void { this.#sink?.(event); }
}

function testUi(
  overlay: { open: boolean; closes: number } = { open: false, closes: 0 },
  onDraw: (state: { text: string; cursor: number }) => void = () => undefined,
  overlayCapturesInput = false,
): InteractiveUi {
  const ui = {
    get overlayOpen() { return overlay.open; },
    overlayCapturesInput,
    promptActive: false,
    approvalActive: false,
    closeOverlay: () => { overlay.open = false; overlay.closes += 1; },
    drawComposer: onDraw,
    eraseComposer: () => undefined,
    notice: () => undefined,
    toggleSidebar: () => false,
    toggleAccordion: () => "",
    cycleThinkingVisibility: () => "",
    scrollPageUp: () => undefined,
    scrollPageDown: () => undefined,
    scrollUp: () => undefined,
    scrollDown: () => undefined,
    scrollOverlay: () => undefined,
    readPrompt: async () => undefined,
  };
  return ui as unknown as InteractiveUi;
}

describe("revision input semantics", () => {
  test("decodes LF, Kitty CSI-u modifiers, text, and release events", () => {
    expect(decodeKeys("\r").events).toEqual([{ key: "enter" }]);
    expect(decodeKeys("\n").events).toEqual([{ key: "ctrl+j" }]);
    expect(decodeKeys("\u001b[112;3u").events).toEqual([{ key: "alt+p" }]);
    expect(decodeKeys("\u001b[116;3u").events).toEqual([{ key: "alt+t" }]);
    expect(decodeKeys("\u001b[13;2u").events).toEqual([{ key: "shift+enter" }]);
    expect(decodeKeys("\u001b[97;1u").events).toEqual([{ key: "text", text: "a" }]);
    expect(decodeKeys("\u001b[112;3:3u").events).toEqual([]);
  });

  test("uses logical multiline columns for arrows and line boundaries", () => {
    const composer = new ComposerSession();
    composer.set("abcd\nx\nabcdef", 3);

    composer.handle({ key: "down" }, IDLE);
    expect(composer.cursor).toBe(6);
    composer.handle({ key: "down" }, IDLE);
    expect(composer.cursor).toBe(10);
    composer.handle({ key: "up" }, IDLE);
    expect(composer.cursor).toBe(6);
    composer.handle({ key: "up" }, IDLE);
    expect(composer.cursor).toBe(3);

    composer.set("abcd\nx\nabcdef", 9);
    composer.handle({ key: "ctrl+a" }, IDLE);
    expect(composer.cursor).toBe(7);
    composer.handle({ key: "ctrl+e" }, IDLE);
    expect(composer.cursor).toBe(13);
  });

  test("implements forward delete, two-stage EOF, remapping, and leader chords", () => {
    let now = 100;
    const composer = new ComposerSession({ now: () => now });
    composer.set("A\ud83d\ude00B", 1);
    expect(composer.handle({ key: "ctrl+d" }, IDLE).kind).toBe("redraw");
    expect(composer.text).toBe("AB");
    composer.clear();
    expect(composer.handle({ key: "ctrl+d" }, IDLE).kind).toBe("notice");
    now += 100;
    expect(composer.handle({ key: "ctrl+d" }, IDLE).kind).toBe("exit");

    const remapped = applyRemapping(DEFAULT_KEYMAP, { model_picker: "ctrl+m" }).keymap;
    const mapped = new ComposerSession({ keymap: remapped });
    expect(mapped.handle({ key: "alt+p" }, IDLE).kind).toBe("none");
    expect(mapped.handle({ key: "ctrl+m" }, IDLE).kind).toBe("redraw");
    expect(mapped.text).toBe("/model ");

    const leader = new ComposerSession();
    expect(leader.handle({ key: "ctrl+x" }, IDLE).kind).toBe("notice");
    expect(leader.handle({ key: "text", text: "A" }, IDLE)).toEqual({
      kind: "open_overlay",
      overlay: "agents",
    });
  });

  test("keeps capturing overlays modal and accepts printable q to close", async () => {
    const keys = new TestKeyStream();
    const overlay = { open: true, closes: 0 };
    const draws: string[] = [];
    const reader = new InputReader({
      keys,
      ui: testUi(overlay, (state) => draws.push(state.text), true),
    });
    reader.start();
    const prompt = reader.readPrompt();

    keys.emit({ key: "text", text: "ignored" });
    expect(draws).toHaveLength(1);
    expect(draws[0]).toBe("");
    keys.emit({ key: "text", text: "q" });
    expect(overlay).toEqual({ open: false, closes: 1 });
    keys.emit({ key: "ctrl+d" });
    keys.emit({ key: "ctrl+d" });
    expect(await prompt).toBeUndefined();
    reader.stop();
  });

  test("gives a pending user ask choice the key stream during a turn", async () => {
    const keys = new TestKeyStream();
    const received: InputEvent[] = [];
    const ui = testUi();
    Object.defineProperty(ui, "userAskActive", { get: () => true });
    (ui as unknown as { handleUserAskKey: (event: InputEvent) => void }).handleUserAskKey = (event) => {
      received.push(event);
    };
    const reader = new InputReader({ keys, ui });
    const controller = new AbortController();
    let release!: () => void;

    reader.start();
    const turn = reader.duringTurn(
      controller,
      { viewModel: emptyViewModel("session") },
      () => new Promise<void>((resolve) => { release = resolve; }),
    );

    keys.emit({ key: "down" });
    keys.emit({ key: "enter" });
    expect(received).toEqual([{ key: "down" }, { key: "enter" }]);
    expect(controller.signal.aborted).toBe(false);

    release();
    await turn;
    reader.stop();
  });

  test("keeps read-only overlays responsive while editing the composer", async () => {
    const keys = new TestKeyStream();
    const overlay = { open: true, closes: 0 };
    const draws: string[] = [];
    const reader = new InputReader({
      keys,
      ui: testUi(overlay, (state) => draws.push(state.text)),
    });
    reader.start();
    const prompt = reader.readPrompt();

    keys.emit({ key: "text", text: "draft" });
    expect(draws.at(-1)).toBe("draft");
    keys.emit({ key: "enter" });

    expect(await prompt).toBe("draft");
    expect(overlay).toEqual({ open: false, closes: 1 });
    reader.stop();
  });

  test("gives completion popup keys priority over a visible document overlay", async () => {
    const keys = new TestKeyStream();
    const overlay = { open: true, closes: 0 };
    let overlayScrolls = 0;
    const draws: string[] = [];
    const ui = testUi(overlay, (state) => draws.push(state.text));
    (ui as unknown as { scrollOverlay: () => void }).scrollOverlay = () => {
      overlayScrolls += 1;
    };
    const reader = new InputReader({ keys, ui });
    reader.start();
    const prompt = reader.readPrompt();

    keys.emit({ key: "text", text: "/" });
    keys.emit({ key: "down" });
    expect(overlayScrolls).toBe(0);
    expect(draws.at(-1)).toBe("/");

    keys.emit({ key: "escape" });
    expect(overlay).toEqual({ open: true, closes: 0 });
    keys.emit({ key: "q" });
    expect(overlay).toEqual({ open: false, closes: 1 });
    keys.emit({ key: "ctrl+u" });
    keys.emit({ key: "ctrl+d" });
    keys.emit({ key: "ctrl+d" });
    expect(await prompt).toBeUndefined();
    reader.stop();
  });

  test("first Escape interrupts only the exact awaited task", async () => {
    const keys = new TestKeyStream();
    const reader = new InputReader({ keys, ui: testUi() });
    const controller = new AbortController();
    const interrupted: string[] = [];
    let release!: () => void;
    const model = { ...emptyViewModel("session"), awaitingTaskId: "agent-2" };
    const turn = reader.duringTurn(
      controller,
      {
        viewModel: model,
        interruptTaskWait: (taskId) => { interrupted.push(taskId); return true; },
      },
      () => new Promise<void>((resolve) => { release = resolve; }),
    );

    keys.emit({ key: "escape" });
    expect(interrupted).toEqual(["agent-2"]);
    expect(controller.signal.aborted).toBe(false);
    release();
    await turn;
  });

  test("a background task is never guessed to be awaited", async () => {
    const keys = new TestKeyStream();
    const reader = new InputReader({ keys, ui: testUi() });
    const controller = new AbortController();
    let interrupted = false;
    let release!: () => void;
    const turn = reader.duringTurn(
      controller,
      {
        viewModel: emptyViewModel("session"),
        interruptTaskWait: () => { interrupted = true; return true; },
      },
      () => new Promise<void>((resolve) => { release = resolve; }),
    );

    keys.emit({ key: "escape" });
    expect(interrupted).toBe(false);
    expect(controller.signal.aborted).toBe(false);
    release();
    await turn;
  });
});

describe("revision live span ownership", () => {
  test("never exposes child text in the root lane and reconciles by owner and item identity", () => {
    const spans = new LiveSpanRegistry();
    spans.append({ text: "root text", phase: "progress", turnId: "turn-1", agentId: "root", itemId: "root_1", nowMs: 1 });
    spans.append({ text: "child text", phase: "progress", turnId: "turn-1", agentId: "agent-2", itemId: "child_1", nowMs: 2 });

    expect(spans.rootText("progress", "turn-1")).toBe("root text");
    const child = spans.reconcile({
      text: "child text",
      phase: "progress",
      turnId: "turn-1",
      agentId: "agent-2",
      itemId: "child_1",
    }, 3);
    expect(child?.status).toBe("landed");
    expect(spans.snapshot().some((span) => span.key.agentId === "agent-2")).toBe(false);
    expect(spans.rootText("progress", "turn-1")).toBe("root text");

    const root = spans.reconcile({
      text: "root text",
      phase: "progress",
      turnId: "turn-1",
      agentId: "root",
      itemId: "root_1",
    }, 4);
    expect(root?.status).toBe("landed");
    expect(spans.rootText("progress", "turn-1")).toBe("");
    expect(spans.snapshot()).toHaveLength(0);
  });

  test("keeps uncorrelated spans separate even when their phase is the same", () => {
    const spans = new LiveSpanRegistry();
    spans.append({ text: "first", phase: "progress", turnId: "turn-1", agentId: "root", nowMs: 1 });
    spans.append({ text: "second", phase: "progress", turnId: "turn-1", agentId: "root", nowMs: 2 });

    const snapshot = spans.snapshot();
    expect(snapshot).toHaveLength(2);
    expect(snapshot[0]?.key.itemId).not.toBe(snapshot[1]?.key.itemId);
  });
  test("never reconciles repeated text without the same provider item identity", () => {
    const spans = new LiveSpanRegistry();
    spans.append({
      text: "Repeated sentence.",
      phase: "candidate_final",
      turnId: "turn-1",
      agentId: "root",
      itemId: "candidate_1",
      nowMs: 1,
    });
    expect(spans.reconcile({
      text: "Repeated sentence.",
      phase: "final",
      turnId: "turn-1",
      agentId: "root",
      itemId: "candidate_2",
    }, 2)).toBeUndefined();
    expect(spans.snapshot()).toHaveLength(1);
    expect(spans.reconcile({
      text: "Repeated sentence.",
      phase: "final",
      turnId: "turn-1",
      agentId: "root",
      itemId: "candidate_1",
    }, 3)?.status).toBe("landed");
  });

  test("lands a candidate final only when its final item is authoritative and closes stale spans", () => {
    const spans = new LiveSpanRegistry();
    spans.append({
      text: "I will inspect first.",
      phase: "candidate_final",
      turnId: "turn-1",
      agentId: "root",
      itemId: "candidate_1",
      nowMs: 1,
    });
    expect(spans.reconcile({
      text: "I will inspect first.",
      phase: "final",
      turnId: "turn-1",
      agentId: "root",
      itemId: "candidate_1",
    }, 2)?.status).toBe("landed");

    expect(spans.snapshot()).toHaveLength(0);
    for (const [index, outcome] of (["failed", "cancelled", "replaced"] as const).entries()) {
      const turnId = `turn-${index + 2}`;
      spans.append({ text: "stale", phase: "reasoning_summary", turnId, agentId: "root", nowMs: index + 3 });
      spans.closeTurn(turnId, outcome, index + 4);
      expect(spans.hasOpenRoot(turnId)).toBe(false);
      expect(spans.snapshot().some((span) => span.key.turnId === turnId)).toBe(false);
    }
    expect(spans.snapshot()).toHaveLength(0);
  });
});
