/**
 * §5.13 manual replay round trip.
 *
 * The ChatGPT account backend has no `previous_response_id`, so continuity there
 * is *only* as good as the replay: every output item kind and the assistant
 * `phase` have to survive being turned back into request input. A kind that is
 * silently dropped costs the model the context it produced, and the loss is
 * invisible — the next request simply looks shorter.
 *
 * This pins the whole set rather than one kind at a time, so adding a sixth item
 * kind without teaching the replay about it fails here.
 */

import { describe, expect, test } from "bun:test";

import {
  replayableResponseItems,
  type ResponseItemEnvelope,
} from "../src/response-items.ts";

function envelope(
  sequence: number,
  kind: ResponseItemEnvelope["kind"],
  item: Omit<ResponseItemEnvelope["item"], "type">,
  extra: Partial<ResponseItemEnvelope> = {},
): ResponseItemEnvelope {
  return {
    itemId: `item-${sequence}`,
    sequence,
    kind,
    // The replay reads `phase` off the item, so an envelope-level phase has to
    // reach the item as well or a preserved phase would only look preserved.
    item: { type: kind, ...item, ...(extra.phase !== undefined ? { phase: extra.phase } : {}) },
    opaque: kind === "reasoning",
    ...extra,
  };
}

/** One envelope of every kind the provider can emit, in wire order. */
function everyKind(): ResponseItemEnvelope[] {
  return [
    envelope(1, "message", { id: "m1", text: "thinking out loud" }, { phase: "commentary" }),
    envelope(2, "reasoning", { id: "r1", encryptedContent: "opaque-blob", text: "summary" }),
    envelope(3, "program", {
      id: "p1",
      callId: "prog-call-1",
      code: "const x = await fs.read({ path: 'a.ts' });",
      fingerprint: "fp-1",
    }),
    envelope(
      4,
      "function_call",
      { id: "f1", callId: "call-1", name: "fs.read", argumentsText: '{"path":"a.ts"}' },
      { callerId: "prog-call-1", programId: "prog-call-1" },
    ),
    envelope(
      5,
      "function_call_output",
      { id: "o1", callId: "call-1", output: "file contents" },
      { callerId: "prog-call-1", programId: "prog-call-1" },
    ),
    envelope(6, "program_output", {
      id: "po1",
      callId: "prog-call-1",
      result: '{"status":"complete"}',
      status: "completed",
    }),
    envelope(7, "message", { id: "m2", text: "here is the answer" }, { phase: "final_answer" }),
  ];
}

describe("manual replay preserves every output item kind", () => {
  test("no kind is dropped", () => {
    const items = replayableResponseItems(everyKind());
    expect(items.map((item) => item.type)).toEqual([
      "message",
      "reasoning",
      "program",
      "function_call",
      "function_call_output",
      "program_output",
      "message",
    ]);
  });

  test("the assistant phase survives on both messages", () => {
    const messages = replayableResponseItems(everyKind()).filter(
      (item): item is Extract<typeof item, { type: "message" }> => item.type === "message",
    );
    // §5.12 requires the phase to be preserved: a commentary message replayed as
    // a final answer would tell the model it already answered.
    expect(messages.map((message) => message.phase)).toEqual(["commentary", "final_answer"]);
  });

  test("program caller linkage survives so a resumed program keeps its lineage", () => {
    const items = replayableResponseItems(everyKind());
    const call = items.find((item) => item.type === "function_call");
    const output = items.find((item) => item.type === "function_call_output");
    expect(call).toMatchObject({ callId: "call-1", callerId: "prog-call-1" });
    expect(output).toMatchObject({ callId: "call-1", callerId: "prog-call-1" });
  });

  test("the reasoning blob replays as opaque content, not as its summary", () => {
    const reasoning = replayableResponseItems(everyKind()).find(
      (item): item is Extract<typeof item, { type: "reasoning" }> => item.type === "reasoning",
    );
    // Replaying the human-readable summary in place of the encrypted blob would
    // silently downgrade continuity to a paraphrase of the model's own thinking.
    expect(reasoning?.opaque).toBe("opaque-blob");
    expect(reasoning?.summaryText).toBe("summary");
  });

  test("items replay in sequence order regardless of arrival order", () => {
    const shuffled = [...everyKind()].reverse();
    expect(replayableResponseItems(shuffled).map((item) => item.type))
      .toEqual(replayableResponseItems(everyKind()).map((item) => item.type));
  });

  test("the round trip is stable, so a second replay is byte-identical", () => {
    expect(replayableResponseItems(everyKind())).toEqual(replayableResponseItems(everyKind()));
  });
});

describe("replay refuses what it cannot faithfully reproduce", () => {
  test("an unknown kind is withheld rather than guessed at", () => {
    const items = replayableResponseItems([
      ...everyKind(),
      envelope(8, "unknown", { id: "u1", text: "some future item" }),
    ]);
    expect(items).toHaveLength(7);
  });

  test("an empty assistant message is withheld", () => {
    // An empty message would replay as a turn the assistant took and said
    // nothing in, which is not what happened.
    const items = replayableResponseItems([envelope(1, "message", { id: "m1", text: "" })]);
    expect(items).toHaveLength(0);
  });

  test("a reasoning item with no encrypted content is withheld", () => {
    const items = replayableResponseItems([
      envelope(1, "reasoning", { id: "r1", text: "summary only" }),
    ]);
    expect(items).toHaveLength(0);
  });

  test("an incomplete program or call is withheld rather than half replayed", () => {
    const items = replayableResponseItems([
      envelope(1, "program", { id: "p1", callId: "c1" }),
      envelope(2, "function_call", { id: "f1", callId: "c2" }),
      envelope(3, "function_call_output", { id: "o1" }),
      envelope(4, "program_output", { id: "po1", callId: "c1" }),
    ]);
    expect(items).toHaveLength(0);
  });

  test("an incomplete program_output does not lose its status", () => {
    const items = replayableResponseItems([
      envelope(1, "program_output", {
        id: "po1",
        callId: "c1",
        result: "partial",
        status: "incomplete",
      }),
    ]);
    expect(items).toEqual([
      { type: "program_output", itemId: "po1", callId: "c1", result: "partial", status: "incomplete" },
    ]);
  });
});
