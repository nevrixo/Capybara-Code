/**
 * Terminal output sanitization — PRD §6.7, §6.20, §T6, RT-004, AC-33.
 *
 * §6.20's list: strip ANSI/OSC/DCS/APC/PM, sanitize CSI except a safe SGR parser,
 * escape control characters, and cap line length. §T6 is the threat this closes:
 * tool output, MCP responses, and Skill text are all attacker-influenced channels
 * that reach a terminal, and a terminal executes what it is sent.
 *
 * The specific damage being prevented:
 *
 * - `OSC 0` / `OSC 2` retitle the window (§6.20 forbids title changes by default)
 * - `OSC 52` writes the system clipboard (§6.20 allows it only on a user action)
 * - `OSC 8` embeds a hyperlink (§6.20 requires an explicit allowlist)
 * - `DCS`/`APC`/`PM` can start a device query whose reply is injected as *input*
 * - a lone `CR` lets text overwrite what was already drawn
 *
 * This is the render-time boundary. `@cbc/mcp-client` also sanitizes at ingest, so
 * a hostile sequence is removed both where it enters and where it would be drawn —
 * neither layer is load-bearing alone.
 */

/** §6.20 default cap so one line cannot force a terminal into a reflow storm. */
export const MAX_LINE_LENGTH = 8 * 1024;

/** §11.6's per-line cap, restated here because sanitization enforces it. */
export const MAX_DISPLAY_LINES = 2_000;

export interface SanitizeOptions {
  /**
   * Keep colour SGR sequences. Only safe for text CBC generated itself; never for
   * external output, where §6.20 requires the CSI parser to be restrictive.
   */
  readonly allowSgr?: boolean;
  readonly maxLineLength?: number;
  readonly maxLines?: number;
  /** §6.20: OSC 8 hyperlinks are permitted only for these URL prefixes. */
  readonly hyperlinkAllowlist?: readonly string[];
}

/**
 * SGR parameters CBC will pass through when `allowSgr` is set.
 *
 * Colour and the common attributes only. Notably absent: `SGR 8` (conceal), which
 * would let output hide itself from the user while still being present.
 */
const SAFE_SGR = /^(?:[0-9]|1|2|3|4|7|9|2[1-9]|3[0-79]|4[0-79]|5[34]|9[0-7]|10[0-7]|38;[25];[0-9;]+|48;[25];[0-9;]+)$/;

function isSafeSgr(params: string): boolean {
  if (params.length === 0) return true; // bare ESC[m resets
  return params.split(";").every((part) => SAFE_SGR.test(part) || /^\d{1,3}$/.test(part));
}

/**
 * Strip every escape sequence from external text.
 *
 * Order matters: the multi-character sequences with string terminators are removed
 * before the two-character forms, otherwise a partially-consumed `OSC` would leave
 * its payload behind as visible garbage.
 */
export function sanitizeText(raw: string, options: SanitizeOptions = {}): string {
  let text = raw;

  // ---- OSC: ESC ] ... (BEL | ST) ----
  text = stripOsc(text, options);
  // An unterminated OSC would otherwise swallow the rest of the buffer at the
  // terminal; drop from the introducer to end of line.
  text = text.replace(/\u001B\][^\u0007\u001B\n]*$/gm, "");

  // ---- DCS, SOS, PM, APC: ESC P/X/^/_ ... ST ----
  text = text.replace(/\u001B[PX^_][\s\S]*?(?:\u001B\\|\u0007|\u009C)/g, "");
  text = text.replace(/\u001B[PX^_][^\u001B\n]*$/gm, "");

  // ---- CSI: ESC [ params intermediates final ----
  text = text.replace(/\u001B\[([0-?]*)([ -/]*)([@-~])/g, (_match, params: string, _mid: string, final: string) => {
    if (options.allowSgr === true && final === "m" && isSafeSgr(params)) {
      return `\u001B[${params}m`;
    }
    // Everything else — cursor movement, erase, scroll region, mode set — is
    // dropped. A tool result has no business moving the cursor.
    return "";
  });

  // ---- Remaining two-character escapes, incl. ESC c (full reset) ----
  text = text.replace(/\u001B[@-Z\\-_0-9a-z]/g, "");
  // A trailing lone ESC.
  text = text.replace(/\u001B$/g, "");

  // ---- C1 controls, which some terminals treat as CSI/OSC introducers ----
  text = text.replace(/[\u0080-\u009F]/g, "");

  // ---- C0 controls ----
  // Tab and newline survive. CR does not: on its own it returns the cursor to
  // column zero, letting later text overwrite earlier text on the same line.
  text = text.replace(/\r\n/g, "\n");
  text = text.replace(/\r/g, "\n");
  // ESC (0x1B) is deliberately excluded from this range. It sits inside
  // \u000E-\u001F, so a blanket sweep would strip the introducer off the very
  // sequences the passes above decided to keep — leaving `[31m` or `]8;;` on
  // screen as literal text.
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/g, "");

  // Any ESC still here introduces a sequence an earlier pass chose to keep: a safe
  // SGR or an allowlisted hyperlink. A stray ESC introducing nothing is removed.
  text = text.replace(/\u001B(?![[\]])/g, "");

  return capLines(text, options);
}

/**
 * Remove OSC sequences, keeping an allowlisted OSC 8 hyperlink intact.
 *
 * A hyperlink is a *pair*: `OSC 8;params;URI` opens it and `OSC 8;;` closes it.
 * The two have to be decided together — dropping a rejected opener but keeping its
 * terminator leaves `]8;;` on screen as literal text once the escape is stripped.
 * `String.replace` visits matches in order, so a single flag is enough to pair them.
 */
function stripOsc(text: string, options: SanitizeOptions): string {
  const allowlist = options.hyperlinkAllowlist;
  let openLinkAllowed = false;

  return text.replace(/\u001B\][\s\S]*?(?:\u0007|\u001B\\|\u009C)/g, (match) => {
    if (allowlist === undefined || allowlist.length === 0) return "";

    const body = /^\u001B\]8;([^;]*);([^\u0007\u001B\u009C]*)/.exec(match);
    if (body === null) {
      // Any other OSC — title, clipboard, notification — is always removed.
      openLinkAllowed = false;
      return "";
    }

    const uri = body[2] ?? "";
    if (uri.length === 0) {
      // The terminator. Keep it only if the link it closes survived.
      const keep = openLinkAllowed;
      openLinkAllowed = false;
      return keep ? match : "";
    }

    openLinkAllowed = allowlist.some((prefix) => uri.startsWith(prefix));
    return openLinkAllowed ? match : "";
  });
}

function capLines(text: string, options: SanitizeOptions): string {
  const maxLineLength = options.maxLineLength ?? MAX_LINE_LENGTH;
  const maxLines = options.maxLines ?? MAX_DISPLAY_LINES;

  const lines = text.split("\n");
  const truncatedLineCount = Math.max(0, lines.length - maxLines);
  const kept = lines.slice(0, maxLines).map((line) =>
    line.length > maxLineLength
      ? `${line.slice(0, maxLineLength)} …[line truncated: ${line.length} characters]`
      : line,
  );

  if (truncatedLineCount > 0) {
    kept.push(`…[${truncatedLineCount} more line(s) omitted]`);
  }
  return kept.join("\n");
}

/**
 * Whether text still contains a dangerous sequence. Used by the §25.5 fuzz target
 * to assert the sanitizer leaves nothing behind.
 */
export function hasForbiddenSequence(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u001B\u0080-\u009F\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F\r]/.test(
    text,
  );
}

/**
 * Sanitize a single-line value for a compact field, e.g. a command on an approval
 * card. Newlines collapse to spaces so the field cannot break the layout.
 */
export function sanitizeInline(raw: string, maxWidth = 200): string {
  const flattened = sanitizeText(raw).replace(/\n+/g, " ").replace(/\s{2,}/g, " ").trim();
  return flattened.length > maxWidth ? `${flattened.slice(0, maxWidth - 1)}…` : flattened;
}

/**
 * §6.7: user text keeps its paste structure but is stripped of escapes.
 *
 * Multiline pastes are preserved because §6.7 requires it; a user pasting a stack
 * trace expects it to stay readable.
 */
export function sanitizeUserInput(raw: string): string {
  return sanitizeText(raw, { maxLines: 10_000 });
}
