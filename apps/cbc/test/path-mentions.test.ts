import { describe, expect, test } from "bun:test";

import { ComposerSession } from "../src/composer.ts";
import {
  WorkspacePathMentionIndex,
  extractPathMentions,
  normalizeWorkspacePath,
  pathMentionToken,
} from "../src/path-mentions.ts";

describe("workspace path mention index", () => {
  function index(): WorkspacePathMentionIndex {
    const result = new WorkspacePathMentionIndex();
    result.replaceFiles([
      { path: "README.md" },
      { path: "src/main.ts" },
      { path: "src/parser/index.ts" },
      { path: "src/parser/token.ts" },
      { path: "tests/main.test.ts" },
      { path: "docs/user guide.md" },
      { path: "src/main.ts" },
    ]);
    return result;
  }

  test("a bare @ shows deduplicated top-level files and folders", () => {
    const candidates = index().candidates("");
    expect(candidates.map((candidate) => candidate.value)).toEqual([
      "docs/",
      "src/",
      "tests/",
      "README.md",
    ]);
    expect(candidates.find((candidate) => candidate.value === "src/")?.detail).toBe(
      "folder · 3 files",
    );
    expect(candidates.every((candidate) => candidate.insert?.endsWith(" "))).toBe(true);
  });

  test("a trailing slash browses exactly one folder level", () => {
    expect(index().candidates("src/").map((candidate) => candidate.value)).toEqual([
      "src/parser/",
      "src/main.ts",
    ]);
    expect(index().candidates("src/parser/").map((candidate) => candidate.value)).toEqual([
      "src/parser/index.ts",
      "src/parser/token.ts",
    ]);
  });

  test("search is case-insensitive and ranks a basename prefix ahead of fuzzy paths", () => {
    const candidates = index().candidates("MAIN");
    expect(candidates.map((candidate) => candidate.value).slice(0, 2)).toEqual([
      "src/main.ts",
      "tests/main.test.ts",
    ]);
  });

  test("Unicode file and folder names remain intact", () => {
    const mentions = new WorkspacePathMentionIndex();
    mentions.replaceFiles([{ path: "문서/안내.md" }]);
    expect(mentions.candidates("안내")[0]).toMatchObject({
      value: "문서/안내.md",
      insert: "@문서/안내.md ",
    });
  });

  test("whitespace paths are inserted as quoted semantic mentions", () => {
    const candidate = index().candidates("guide")[0];
    expect(candidate).toEqual({
      value: "docs/user guide.md",
      detail: "file",
      insert: '@"docs/user guide.md" ',
    });
    expect(pathMentionToken("docs/user guide.md")).toBe('@"docs/user guide.md"');
  });

  test("unsafe and terminal-control paths never enter the popup", () => {
    const mentions = new WorkspacePathMentionIndex();
    mentions.replaceFiles([
      { path: "../outside.txt" },
      { path: "/absolute.txt" },
      { path: "C:\\absolute.txt" },
      { path: "C:drive-relative.txt" },
      { path: "src/evil\u001b[2J.ts" },
      { path: "src/c1\u009b2J.ts" },
      { path: "src/arabic-mark\u061c.ts" },
      { path: "src/ltr-mark\u200e.ts" },
      { path: "src/spoof\u202ets.txt" },
      { path: ".env" },
      { path: ".ssh/id_ed25519" },
      { path: "./safe\\file.ts" },
    ]);

    expect(mentions.candidates("").map((candidate) => candidate.value)).toEqual(["safe/"]);
    expect(mentions.candidates("safe/").map((candidate) => candidate.value)).toEqual([
      "safe/file.ts",
    ]);
    expect(normalizeWorkspacePath("../x")).toBeUndefined();
  });

  test("submitted text extracts file and quoted folder mentions without treating email as a path", () => {
    expect(
      extractPathMentions(
        'check @src/main.ts, then @"docs/user guide.md" and @src/parser/; mail dev@example.com',
      ),
    ).toEqual(["src/main.ts", "docs/user guide.md", "src/parser/"]);
  });

  test("mention extraction normalizes, deduplicates, and rejects traversal", () => {
    expect(
      extractPathMentions("@./src\\main.ts @src/main.ts @../secret @/outside @"),
    ).toEqual(["src/main.ts"]);
  });

  test("the result cap is enforced after ranking", () => {
    const mentions = new WorkspacePathMentionIndex();
    mentions.replaceFiles(Array.from({ length: 20 }, (_, index) => ({ path: `file-${index}.ts` })));
    expect(mentions.candidates("file", { limit: 4 })).toHaveLength(4);
  });

  test("adversarial deep repositories keep synchronous keypress work bounded", () => {
    const mentions = new WorkspacePathMentionIndex();
    mentions.replaceFiles(Array.from({ length: 6_000 }, (_, index) => ({
      path: `root-${index}/nested-${index}/file.ts`,
    })));

    expect(mentions.size).toBeLessThanOrEqual(10_000);
    expect(mentions.candidates("file", { limit: 8 })).toHaveLength(8);
  });
});


describe("composer path mentions", () => {
  const idle = { turnRunning: false };

  function type(composer: ComposerSession, text: string): void {
    for (const character of text) composer.handle({ key: "text", text: character }, idle);
  }

  function composer(): ComposerSession {
    const mentions = new WorkspacePathMentionIndex();
    mentions.replaceFiles([
      { path: "src/main.ts" },
      { path: "src/parser.ts" },
      { path: "tests/main.test.ts" },
    ]);
    return new ComposerSession({
      sources: { paths: (query) => mentions.candidates(query) },
    });
  }

  test("typing @ opens file suggestions and acceptance preserves the mention marker", () => {
    const session = composer();
    type(session, "please inspect @src/ma");

    expect(session.completionOpen).toBe(true);
    expect(session.completion.kind).toBe("path");
    expect(session.completion.candidates[0]?.value).toBe("src/main.ts");
    expect(session.handle({ key: "enter" }, idle)).toEqual({ kind: "redraw" });
    expect(session.text).toBe("please inspect @src/main.ts ");
    expect(session.completionOpen).toBe(false);

    expect(session.handle({ key: "enter" }, idle)).toEqual({
      kind: "submit",
      text: "please inspect @src/main.ts",
    });
  });


  test("a background scan can open suggestions without another keypress", () => {
    let ready = false;
    const session = new ComposerSession({
      sources: {
        paths: () => ready ? [{ value: "README.md", insert: "@README.md " }] : [],
      },
    });

    type(session, "@");
    expect(session.completionOpen).toBe(false);
    ready = true;
    session.refreshCompletions();
    expect(session.completionOpen).toBe(true);
    expect(session.completion.candidates[0]?.value).toBe("README.md");
  });

  test("an async refresh preserves selection and respects an explicit Esc dismissal", () => {
    let candidates = [
      { value: "a.ts", insert: "@a.ts " },
      { value: "b.ts", insert: "@b.ts " },
    ];
    const session = new ComposerSession({ sources: { paths: () => candidates } });
    type(session, "@");
    session.handle({ key: "down" }, idle);
    expect(session.completion.candidates[session.completion.selected]?.value).toBe("b.ts");

    candidates = [
      { value: "c.ts", insert: "@c.ts " },
      { value: "b.ts", insert: "@b.ts " },
      { value: "a.ts", insert: "@a.ts " },
    ];
    session.refreshCompletions();
    expect(session.completion.candidates[session.completion.selected]?.value).toBe("b.ts");

    session.handle({ key: "escape" }, idle);
    expect(session.completionOpen).toBe(false);
    session.refreshCompletions();
    expect(session.completionOpen).toBe(false);
  });

  test("accepting a mention before a paste chip keeps submitted paste bytes intact", () => {
    const session = composer();
    type(session, " after ");
    const pasted = "one\ntwo\nthree\nfour";
    session.handle({ key: "paste", text: pasted }, idle);
    session.handle({ key: "home" }, idle);
    type(session, "@src/ma");

    session.handle({ key: "tab" }, idle);
    expect(session.text).toBe("@src/main.ts after [paste #1 +4 lines]");
    expect(session.handle({ key: "enter" }, idle)).toEqual({
      kind: "submit",
      text: `@src/main.ts after ${pasted}`,
    });
  });

  test("folders are committed as mentions rather than forcing a child selection", () => {
    const session = composer();
    type(session, "use @sr");
    expect(session.completion.candidates[0]?.value).toBe("src/");

    session.handle({ key: "tab" }, idle);
    expect(session.text).toBe("use @src/ ");
    expect(session.completionOpen).toBe(false);
  });
});
