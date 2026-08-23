import { expect, test } from "bun:test";

import { TerminalFrameWriter } from "../src/terminal-writer.ts";

test("a full frame does not advance past the terminal's final row", () => {
  const writes: string[] = [];
  const writer = new TerminalFrameWriter({
    write(text) {
      writes.push(text);
      return true;
    },
  });
  const cursor = "\u001B[1;2H";

  writer.writeFrame(["home", "status"], cursor, { full: true });

  expect(writes).toEqual(["\u001B[2J\u001B[Hhome\r\nstatus" + cursor]);
  expect(writes[0]).not.toContain("status\r\n" + cursor);
});
