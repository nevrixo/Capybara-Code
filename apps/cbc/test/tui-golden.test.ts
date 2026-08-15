/**
 * Golden TUI tests — PRD §25.8, P1-02.
 *
 * These render `fixtures/tui-golden/*.json` through the *same* `composeScreen`
 * the production frame renderer calls, so a drift between the golden
 * expectations and the real layout path fails here rather than shipping.
 * Assertions are against semantic plain text (the cells the user reads), never
 * ANSI bytes, so a palette change does not churn the fixtures (§6.5).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { EventSequencer, createEvent, type CbcEvent, type CbcEventKind } from "@cbc/protocol";
import { replay } from "@cbc/session-domain";
import {
  composeScreen,
  type StyledLine,
  type TerminalCapabilities,
} from "@cbc/tui-components";

const FIXTURE_DIR = join(import.meta.dir, "../../../fixtures/tui-golden");

interface GoldenExpect {
  readonly mustContain?: readonly string[];
  readonly mustNotContain?: readonly string[];
}

interface GoldenWidth {
  readonly columns: number;
  readonly breakpoint?: string;
  readonly mustContain?: readonly string[];
  readonly expectWarning?: boolean;
}

interface GoldenFixture {
  readonly columns?: number;
  readonly capabilities?: Record<string, unknown>;
  readonly events: readonly { readonly kind: string; readonly payload: unknown }[];
  readonly widths?: readonly GoldenWidth[];
  readonly expect?: GoldenExpect;
}

function loadFixture(name: string): GoldenFixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as GoldenFixture;
}

function eventsFor(fixture: GoldenFixture, sessionId: string): CbcEvent[] {
  const sequencer = new EventSequencer();
  return fixture.events.map((event) =>
    createEvent(sequencer, event.kind as CbcEventKind, event.payload, { sessionId }),
  );
}

function capabilitiesFor(fixture: GoldenFixture, columns: number): TerminalCapabilities {
  const raw = fixture.capabilities ?? {};
  return {
    colorDepth: raw.colorDepth !== undefined ? (raw.colorDepth as TerminalCapabilities["colorDepth"]) : "none",
    italic: raw.italic === true,
    unicode: raw.unicode !== false,
    stableEmojiWidth: raw.stableEmojiWidth !== false,
    reducedMotion: true,
    mouse: raw.mouse === true,
    columns,
    rows: 40,
    hyperlinks: raw.hyperlinks === true,
  };
}

/** Flatten a composed frame to the plain text a reader would see. */
function plainText(lines: readonly StyledLine[]): string {
  return lines.map((line) => line.segments.map((segment) => segment.text).join("")).join("\n");
}

function renderAt(fixture: GoldenFixture, columns: number): string {
  const model = replay("golden", eventsFor(fixture, "golden"));
  const screen = composeScreen({
    model,
    composer: { text: "", cursor: 0 },
    capabilities: capabilitiesFor(fixture, columns),
  });
  return plainText(screen.lines);
}

describe("golden TUI (P1-02: production and golden share composeScreen)", () => {
  test("turn-with-approval renders the approval, denial, and partial report", () => {
    const fixture = loadFixture("turn-with-approval.json");
    const text = renderAt(fixture, fixture.columns ?? 100);

    for (const expected of fixture.expect?.mustContain ?? []) {
      expect(text).toContain(expected);
    }
    for (const forbidden of fixture.expect?.mustNotContain ?? []) {
      expect(text).not.toContain(forbidden);
    }
  });

  test("narrow-terminal keeps the highest-priority status fields at every width", () => {
    const fixture = loadFixture("narrow-terminal.json");
    for (const width of fixture.widths ?? []) {
      const text = renderAt(fixture, width.columns);
      for (const expected of width.mustContain ?? []) {
        expect(text, `width ${width.columns}`).toContain(expected);
      }
      for (const expected of fixture.expect?.mustContain ?? []) {
        expect(text, `width ${width.columns}`).toContain(expected);
      }
    }
  });
});
