#!/usr/bin/env bun
/**
 * Generates the fixtures that cannot be written as reviewable text — PRD §25.15,
 * §25.5, §25.10, AC-33, AC-44.
 *
 * Three kinds of fixture need this: files containing raw control bytes, files that are
 * large enough that committing them would be unreasonable, and a fuzz corpus. A file
 * full of literal ESC bytes is unreviewable in a diff and easy to mangle in an editor,
 * so the *intent* is committed here and the bytes are produced on demand.
 *
 * ```bash
 * bun run fixtures/generate.ts          # write every generated fixture
 * bun run fixtures/generate.ts --check  # verify they exist and match, without writing
 * ```
 *
 * `--check` exists so CI can catch a fixture that was edited by hand instead of
 * regenerated.
 */

const HERE = new URL(".", import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, "$1")
  .replace(/\/+$/, "");

const ESC = "\u001B";
const BEL = "\u0007";

interface Generated {
  readonly path: string;
  readonly content: string;
  readonly note: string;
}

/**
 * §24.4 T6 / AC-33: every escape family a terminal will act on.
 *
 * Each line pairs a marker with a payload so a test can assert the marker survived and
 * the payload did not — "the sequence was stripped" and "the text was destroyed" look
 * the same without that.
 */
function terminalEscapeReport(): string {
  return [
    "Build report",
    // CSI: erase display and home the cursor.
    `csi-clear ${ESC}[2J${ESC}[H cleared-your-screen`,
    // OSC 0: set the window title, terminated by BEL.
    `osc-title ${ESC}]0;pwned${BEL} title-was-set`,
    // OSC 8: hyperlink. Not on the allowlist, so both halves must go.
    `osc8-link ${ESC}]8;;file:///etc/passwd${ESC}\\innocent text${ESC}]8;;${ESC}\\ end-link`,
    // OSC 52: write the system clipboard.
    `osc52-clipboard ${ESC}]52;c;cGF5bG9hZA==${BEL} clipboard-written`,
    // DCS: device control string.
    `dcs ${ESC}Pq#0garbage${ESC}\\ device-control`,
    // Alternate screen switch.
    `alt-screen ${ESC}[?1049h switched`,
    // A bare ESC with no introducer.
    `bare-esc ${ESC} lone-escape`,
    // C1 8-bit CSI, which some terminals still honour.
    `c1-csi \u009B2J eight-bit`,
    // Carriage return used to overwrite the visible line.
    "cr-overwrite visible\rHIDDEN",
    // Backspaces used the same way.
    "bs-overwrite visible\b\b\b\b\b\b\bHIDDEN",
    // SGR only. With allowSgr this one is allowed to survive.
    `sgr-only ${ESC}[31mred${ESC}[0m and ${ESC}[1mbold${ESC}[0m`,
    "end of report",
    "",
  ].join("\n");
}

/** §25.5 fuzz corpus seed for the frame decoder. One record per line, hex-encoded. */
function frameFuzzCorpus(): string {
  const records: string[] = [];
  const hex = (bytes: readonly number[]): string =>
    bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");

  const body = (text: string): number[] => [...new TextEncoder().encode(text)];
  const framed = (text: string): number[] => {
    const payload = body(text);
    const length = payload.length;
    return [
      (length >>> 24) & 0xff,
      (length >>> 16) & 0xff,
      (length >>> 8) & 0xff,
      length & 0xff,
      ...payload,
    ];
  };

  // Well-formed, for a baseline.
  records.push(`# a valid single frame`);
  records.push(hex(framed('{"jsonrpc":"2.0","id":1,"method":"fs.read"}')));

  // Two frames in one chunk, which the decoder must split.
  records.push("# two frames back to back");
  records.push(hex([...framed('{"jsonrpc":"2.0","id":1}'), ...framed('{"jsonrpc":"2.0","id":2}')]));

  // A length prefix with no body: the decoder must wait, not fail.
  records.push("# prefix only, body pending");
  records.push(hex([0x00, 0x00, 0x00, 0x10]));

  // Declared length zero, which §20.1 forbids.
  records.push("# zero length must be rejected");
  records.push(hex([0x00, 0x00, 0x00, 0x00]));

  // Declared length beyond the 8 MiB ceiling.
  records.push("# oversized declared length must be rejected");
  records.push(hex([0x7f, 0xff, 0xff, 0xff]));

  // Truncated UTF-8 in the middle of a code point.
  records.push("# truncated utf-8 sequence");
  records.push(hex([0x00, 0x00, 0x00, 0x02, 0xe2, 0x82]));

  // Valid framing, invalid JSON.
  records.push("# framed but unparseable");
  records.push(hex(framed("{not json")));

  // Deeply nested JSON, to exercise the depth limit.
  records.push("# 128 levels of nesting exceeds maxJsonDepth 64");
  records.push(hex(framed(`${"[".repeat(128)}1${"]".repeat(128)}`)));

  return `${records.join("\n")}\n`;
}

/**
 * AC-44 / §11.6: output large enough to force truncation and an artifact.
 *
 * Both dimensions are exercised because they cap independently: a single line over the
 * per-line byte cap, and a line count over the inline limit.
 */
function oversizedOutput(): string {
  const longLine = `LONGLINE ${"x".repeat(12_000)} END`;
  const manyLines = Array.from({ length: 900 }, (_, index) => `line ${index + 1} of 900`);
  return [
    "header before the long line",
    longLine,
    "header before the many lines",
    ...manyLines,
    "trailer that must not appear inline",
    "",
  ].join("\n");
}

/**
 * §24.4 T4: credential-shaped strings.
 *
 * Constructed to match the detector's shapes. None of these is a real credential, and
 * the file states so in-band so a scanner hitting this repository has an answer.
 */
function secretContent(): string {
  return [
    "# Not real credentials",
    "",
    "Every value below is synthetic and exists to trip the secret detector (§14.8).",
    "",
    `openai_key = "sk-${"A".repeat(20)}notarealkey${"0".repeat(8)}"`,
    `aws_access_key_id = "AKIA${"IOSFODNN7EXAMPL"}E"`,
    `aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"`,
    `github_pat = "ghp_${"0".repeat(36)}"`,
    `slack_token = "xoxb-000000000000-000000000000-${"a".repeat(24)}"`,
    `google_api_key = "AIza${"0".repeat(35)}"`,
    "private_key = \"-----BEGIN RSA PRIVATE KEY-----\\nMIIBOgIBAAJBAK\\n-----END RSA PRIVATE KEY-----\"",
    `bearer = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.${"s".repeat(43)}"`,
    "",
    "A normal value that must not be redacted: version = \"1.2.3\"",
    "",
  ].join("\n");
}

/** A patch that would commit a credential, for §12.6's pre-write scan. */
function secretPatch(): string {
  return [
    "--- a/config.ts",
    "+++ b/config.ts",
    "@@ -1,2 +1,3 @@",
    " export const config = {",
    `+  apiKey: "sk-${"B".repeat(20)}alsonotreal${"1".repeat(8)}",`,
    " };",
    "",
  ].join("\n");
}

const GENERATED: readonly Generated[] = [
  {
    path: "malicious-workspaces/terminal-escape/report.txt",
    content: terminalEscapeReport(),
    note: "raw ESC, BEL, and C1 bytes (AC-33)",
  },
  {
    path: "malicious-workspaces/oversized-output/huge.txt",
    content: oversizedOutput(),
    note: "over both the per-line and line-count caps (AC-44)",
  },
  {
    path: "malicious-workspaces/secret-content/credentials.toml",
    content: secretContent(),
    note: "synthetic credential shapes (AC-39)",
  },
  {
    path: "malicious-workspaces/secret-content/add-secret.patch",
    content: secretPatch(),
    note: "a patch §12.6 must refuse",
  },
  {
    path: "provider-events/frame-decoder.corpus.hex",
    content: frameFuzzCorpus(),
    note: "fuzz corpus seed for the frame decoder (§25.5)",
  },
];

async function main(argv: readonly string[]): Promise<number> {
  const checkOnly = argv.includes("--check");
  let mismatched = 0;

  for (const fixture of GENERATED) {
    const full = `${HERE}/${fixture.path}`;
    if (checkOnly) {
      const file = Bun.file(full);
      if (!(await file.exists())) {
        console.error(`missing: ${fixture.path}`);
        mismatched += 1;
        continue;
      }
      if ((await file.text()) !== fixture.content) {
        console.error(`stale: ${fixture.path} (run \`bun run fixtures/generate.ts\`)`);
        mismatched += 1;
        continue;
      }
      console.log(`ok      ${fixture.path}`);
      continue;
    }

    await Bun.write(full, fixture.content);
    console.log(
      `wrote   ${fixture.path.padEnd(52)} ${new TextEncoder().encode(fixture.content).byteLength} B  ${fixture.note}`,
    );
  }

  if (checkOnly) {
    if (mismatched > 0) {
      console.error(`\n${mismatched} generated fixture(s) are missing or stale`);
      return 1;
    }
    console.log(`\n${GENERATED.length} generated fixture(s) are current`);
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}

export { GENERATED, main as generateFixtures, terminalEscapeReport, frameFuzzCorpus };
