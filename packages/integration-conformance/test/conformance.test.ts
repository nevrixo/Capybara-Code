import { describe, expect, test } from "bun:test";

import {
  APP_CAPABILITY_SCHEMA_REVISION,
  APP_METHOD_CAPABILITY_STATES,
  APP_METHODS,
  type EventReplayResult,
} from "@cbc/app-protocol";
import { EventReplayProjector } from "@cbc/integration-core";

import { CANONICAL_INTEGRATION_TRANSCRIPT } from "../src/index.ts";

describe("integration conformance fixture", () => {
  test("orders initialize before replay and yields a canonical replay projection", () => {
    const methods = CANONICAL_INTEGRATION_TRANSCRIPT.messages
      .filter((message) => typeof message.method === "string")
      .map((message) => message.method);
    expect(methods).toEqual(["server.initialize", "events.replay", "turn.submit"]);

    const replayMessage = CANONICAL_INTEGRATION_TRANSCRIPT.messages.find((message) => {
      const result = message.result;
      return typeof result === "object" && result !== null && "events" in result;
    });
    const result = replayMessage?.result as EventReplayResult | undefined;
    expect(result).toBeDefined();
    if (result === undefined) return;
    const projection = new EventReplayProjector("session_fixture").apply(result);
    expect(projection.completeness).toBe("complete");
    expect(projection.events.map((event) => event.id)).toEqual(["event_1", "event_2"]);
  });

  test("keeps generated TypeScript and Python capability constants aligned", async () => {
    const generated = await Bun.file(
      new URL("../../sdk-python/capybara_code/generated.py", import.meta.url),
    ).text();
    expect(generated).toContain(
      "CAPABILITY_SCHEMA_REVISION = " + JSON.stringify(APP_CAPABILITY_SCHEMA_REVISION),
    );
    const methods = pythonTuple(generated, "APP_METHODS");
    const states = pythonTuple(generated, "METHOD_CAPABILITY_STATES");
    expect(methods).toEqual([...APP_METHODS]);
    expect(states).toEqual([...APP_METHOD_CAPABILITY_STATES]);
  });
});

function pythonTuple(source: string, name: string): string[] {
  const body = new RegExp(name + " = \\(([\\s\\S]*?)\\)", "u").exec(source)?.[1] ?? "";
  return [...body.matchAll(/^\s*("[^"]+"),$/gmu)].map((match) => JSON.parse(match[1]!) as string);
}
