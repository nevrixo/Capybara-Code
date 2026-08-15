/**
 * Terminal key decoding — PRD §6.14, §6.15, §7.7, AC-05, AC-20, AC-21.
 *
 * §6.15's keymap names keys (`ctrl+p`, `escape`, `up`); a terminal delivers bytes.
 * This module is the translation, and it is a pure function of the byte string so
 * §25.2 can drive the whole composer and interrupt path without a PTY.
 *
 * Two decisions worth stating:
 *
 * - A bare `Esc` is only reported as `escape` when it is not the start of a longer
 *   sequence in the same chunk. An arrow key arrives as `Esc [ A`, and a decoder
 *   that emitted `escape` first would cancel a turn every time the user pressed Up.
 * - Bracketed paste content is emitted as one `paste` event rather than as
 *   individual keys. §6.14 requires a multi-line paste to survive intact, and
 *   replaying it as keystrokes would let an embedded newline submit the prompt —
 *   which is also the §6.20 attack where pasted text runs itself.
 */

/** A decoded key press. */
export interface KeyEvent {
  /** Canonical name matching `@cbc/tui-components`' keymap, e.g. `ctrl+c`. */
  readonly key: string;
  /** Printable text this key contributes, for `key === "text"` and `"paste"`. */
  readonly text?: string;
}

/** A decoded mouse event (SGR mouse mode 1006). */
export interface MouseEvent {
  readonly kind: "mouse";
  /** Button number. 0 = left, 1 = middle, 2 = right, 3 = release, 64+ = wheel. */
  readonly button: number;
  /** 0-based column, as reported by the terminal. */
  readonly column: number;
  /** 0-based row, as reported by the terminal. */
  readonly row: number;
  /** Shift held. */
  readonly shift: boolean;
  /** Alt (Meta) held. */
  readonly alt: boolean;
  /** Ctrl held. */
  readonly ctrl: boolean;
  /**
   * `true` while the button is held between press and release. SGR mode reports a
   * release with a lowercase `m`, so a press→drag→release sequence is well-formed
   * even across chunk boundaries.
   */
  readonly pressed: boolean;
}

export type InputEvent = KeyEvent | MouseEvent;

/** Whether an `InputEvent` is a mouse event. */
export function isMouseEvent(event: InputEvent): event is MouseEvent {
  return (event as MouseEvent).kind === "mouse";
}

const CSI_KEYS: Readonly<Record<string, string>> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  Z: "shift+tab",
};

const CSI_TILDE_KEYS: Readonly<Record<string, string>> = {
  "1": "home",
  "2": "insert",
  "3": "delete",
  "4": "end",
  "5": "pageup",
  "6": "pagedown",
};

const BRACKETED_PASTE_START = "200~";
const BRACKETED_PASTE_END = "\u001B[201~";

/** Streaming decoder state carried across chunks. */
export interface KeyDecodeState {
  pendingPaste?: string;
  pendingControl?: string;
  /**
   * A partial escape sequence that ended mid-way through a chunk (P1-01):
   * a bare `Esc`, an unterminated CSI/SS3, or the start of a paste end
   * marker. Terminals split input at arbitrary byte boundaries, and an arrow
   * key arriving as `Esc` + `[A` in two chunks must decode as `up`, not as
   * `escape` plus the text `[A`.
   */
  pendingSequence?: string;
}

/** Longest a buffered partial sequence may grow before it is flushed as text. */
const MAX_PENDING_SEQUENCE = 32;

/**
 * Decode one chunk of terminal input into key events.
 *
 * `pendingPaste` carries an unterminated paste across chunks: a large paste arrives
 * split, and treating each fragment as a fresh chunk would emit half of it as
 * keystrokes. `pendingSequence` does the same for escape sequences themselves, so
 * a CSI or paste marker split across two chunks never leaks bytes into the
 * composer (P1-01).
 */
export function decodeKeys(
  chunk: string,
  state: KeyDecodeState = {},
): { events: InputEvent[] } & KeyDecodeState {
  const events: InputEvent[] = [];
  let index = 0;
  let text = "";

  const flushText = (): void => {
    if (text.length === 0) return;
    events.push({ key: "text", text });
    text = "";
  };

  // A partial escape sequence from the previous chunk is rejoined with this
  // one before decoding. If it has grown past any plausible sequence length
  // it is emitted literally rather than buffered forever.
  let input = chunk;
  if (state.pendingSequence !== undefined) {
    const joined = state.pendingSequence + chunk;
    if (joined.length > MAX_PENDING_SEQUENCE) {
      text += joined;
      flushText();
      return { events };
    }
    input = joined;
  }

  // Terminal capability replies are input bytes too. In particular OpenTUI asks
  // for the foreground/background palette with OSC 10/11; if those replies reach
  // the composer they look like a long string of `rgb:...` text. Discard terminal
  // control strings while preserving ordinary Alt-key and CSI key handling.
  if (state.pendingControl !== undefined) {
    const end = controlStringEnd(input, 0);
    if (end === undefined) {
      return { events, pendingControl: state.pendingControl + chunk };
    }
    index = end;
  }

  // Continue a paste that was still open when the previous chunk ended. The
  // open body and the new bytes are searched together, because the end marker
  // itself may be split across the chunk boundary (P1-01).
  if (state.pendingPaste !== undefined) {
    const open = state.pendingPaste;
    const combined = open + input.slice(index);
    const end = combined.indexOf(BRACKETED_PASTE_END);
    if (end === -1) {
      // Hold back any tail that is a prefix of the marker so it can complete
      // on the next call instead of leaking into the pasted text.
      const hold = pasteEndPrefixLength(combined);
      return {
        events,
        pendingPaste: combined.slice(0, combined.length - hold),
      };
    }
    events.push({ key: "paste", text: combined.slice(0, end) });
    const consumed = end + BRACKETED_PASTE_END.length - open.length;
    index += Math.max(0, consumed);
  }

  while (index < input.length) {
    const char = input[index] as string;

    if (char === "\u001B") {
      const next = input[index + 1];

      if (next !== undefined && isControlStringIntroducer(next)) {
        flushText();
        const end = controlStringEnd(input, index + 2);
        if (end === undefined) {
          return { events, pendingControl: input.slice(index) };
        }
        index = end;
        continue;
      }

      if (next === "[") {
        const consumed = decodeCsi(input, index);
        if (consumed !== undefined) {
          if (consumed.paste === "start") {
            flushText();
            const bodyStart = index + consumed.length;
            const end = input.indexOf(BRACKETED_PASTE_END, bodyStart);
            if (end === -1) {
              // Keep any partial end marker inside the pending body: the next
              // chunk's continuation search sees both sides of the split.
              return { events, pendingPaste: input.slice(bodyStart) };
            }
            events.push({ key: "paste", text: input.slice(bodyStart, end) });
            index = end + BRACKETED_PASTE_END.length;
            continue;
          }
          if (consumed.mouse !== undefined) {
            flushText();
            events.push(consumed.mouse);
          }
          if (consumed.key !== undefined) {
            flushText();
            events.push(
              consumed.text === undefined
                ? { key: consumed.key }
                : { key: consumed.key, text: consumed.text },
            );
          }
          index += consumed.length;
          continue;
        }
        // An unterminated CSI at the chunk edge may complete in the next
        // chunk; buffer it instead of emitting `escape` plus stray text.
        flushText();
        return { events, pendingSequence: input.slice(index) };
      }

      if (next === "O") {
        // Application cursor mode: `Esc O A` for the arrows.
        const letter = input[index + 2];
        if (letter === undefined) {
          flushText();
          return { events, pendingSequence: input.slice(index) };
        }
        const mapped = CSI_KEYS[letter];
        if (mapped !== undefined) {
          flushText();
          events.push({ key: mapped });
          index += 3;
          continue;
        }
        // Unknown SS3 final byte: consume the whole sequence rather than
        // leaking its tail as text.
        flushText();
        index += 3;
        continue;
      }

      if (next === undefined) {
        // `Esc` at the very end of a chunk: it may be the start of an arrow
        // key whose rest arrives in the next chunk. A genuine bare Escape is
        // indistinguishable at this layer; the next chunk decides.
        flushText();
        return { events, pendingSequence: "\u001B" };
      }

      if (next !== "\u001B") {
        // `Esc` followed by a printable character is Alt+that key. Reported as the
        // key alone so an unbound Alt chord does not insert stray text.
        flushText();
        events.push({ key: `alt+${next.toLowerCase()}` });
        index += 2;
        continue;
      }

      flushText();
      events.push({ key: "escape" });
      index += 1;
      continue;
    }

    switch (char) {
      case "\r":
        flushText();
        events.push({ key: "enter" });
        index += 1;
        continue;
      case "\n":
        flushText();
        events.push({ key: "ctrl+j" });
        index += 1;
        continue;
      case "\t":
        flushText();
        events.push({ key: "tab" });
        index += 1;
        continue;
      case "\u007F":
      case "\b":
        flushText();
        events.push({ key: "backspace" });
        index += 1;
        continue;
      default:
        break;
    }

    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20) {
      flushText();
      // `Ctrl+A` is 0x01 through `Ctrl+Z` at 0x1A.
      const letter = String.fromCharCode(code + 96);
      events.push({ key: /[a-z]/.test(letter) ? `ctrl+${letter}` : `ctrl+${code}` });
      index += 1;
      continue;
    }

    text += char;
    index += char.length;
  }

  flushText();
  return { events };
}

/**
 * The number of trailing characters of `text` that form a prefix of the
 * bracketed-paste end marker.
 *
 * When a paste body ends exactly at a chunk boundary mid-marker, those bytes
 * must wait for the next chunk; appending them to the paste body would leak
 * `\u001B[20` into the pasted text (P1-01).
 */
export function pasteEndPrefixLength(text: string): number {
  const max = Math.min(BRACKETED_PASTE_END.length - 1, text.length);
  for (let length = max; length > 0; length -= 1) {
    if (BRACKETED_PASTE_END.startsWith(text.slice(text.length - length))) return length;
  }
  return 0;
}

/**
 * Flush a leftover partial sequence when no more bytes arrive.
 *
 * A bare `Esc` buffered at a chunk edge is a real Escape press when the next
 * chunk does not follow within the terminal's inter-key gap; anything longer
 * is an incomplete sequence and is dropped rather than emitted as text.
 */
export function flushPendingSequence(state: KeyDecodeState): { events: InputEvent[] } & KeyDecodeState {
  if (state.pendingSequence === undefined) return { events: [] };
  if (state.pendingSequence === "\u001B") {
    return { events: [{ key: "escape" }] };
  }
  return { events: [] };
}

/** OSC, DCS, APC, PM, and SOS terminate with BEL or the string terminator `Esc \\`. */
function controlStringEnd(chunk: string, start: number): number | undefined {
  const bell = chunk.indexOf("\u0007", start);
  const stringTerminator = chunk.indexOf("\u001B\\", start);
  if (bell === -1 && stringTerminator === -1) return undefined;
  if (bell !== -1 && (stringTerminator === -1 || bell < stringTerminator)) return bell + 1;
  return stringTerminator + 2;
}

function isControlStringIntroducer(value: string): boolean {
  return value === "]" || value === "P" || value === "_" || value === "^" || value === "X";
}

/**
 * Decode a CSI sequence starting at `start`.
 *
 * Returns the number of characters consumed so the caller advances past the whole
 * sequence. An unterminated sequence returns `undefined`, which makes the caller
 * fall through and treat the `Esc` literally rather than swallowing the rest of the
 * chunk.
 */
function decodeCsi(
  chunk: string,
  start: number,
): { length: number; key?: string; text?: string; paste?: "start"; mouse?: MouseEvent } | undefined {
  let index = start + 2;
  let parameters = "";
  // SGR mouse mode (1006) sequences start with `<`: `CSI < button ; col ; row M/m`.
  let sgrMouse = false;
  if (chunk[start + 1] === "[" && chunk[index] === "<") {
    sgrMouse = true;
    index += 1;
  }

  while (index < chunk.length) {
    const char = chunk[index] as string;
    // CSI parameter/intermediate bytes span U+0020 through U+003F. Keeping the
    // whole sequence together prevents device-capability replies such as
    // `Esc [ > 0 ; 1 c` from leaking their tail into the composer as text.
    if (char >= " " && char <= "?") {
      parameters += char;
      index += 1;
      continue;
    }

    const length = index - start + 1;

    if (sgrMouse && (char === "M" || char === "m")) {
      const mouse = parseSgrMouse(parameters, char === "M");
      if (mouse !== undefined) return { length, mouse };
      return { length };
    }

    if (char === "u") {
      const parts = parameters.split(";");
      const codepoint = Number.parseInt((parts[0] ?? "").split(":")[0] ?? "", 10);
      const modifierParts = (parts[1] ?? "1").split(":");
      const modifier = Number.parseInt(modifierParts[0] ?? "1", 10);
      const eventType = Number.parseInt(modifierParts[1] ?? "1", 10);
      if (eventType === 3) return { length };
      const decoded = modifiedCodepointInput(codepoint, modifier);
      return decoded === undefined ? { length } : { length, ...decoded };
    }

    if (char === "~") {
      if (parameters === BRACKETED_PASTE_START.slice(0, -1)) {
        return { length, paste: "start" };
      }
      const parts = parameters.split(";");
      if (parts[0] === "27" && parts.length >= 3) {
        const modifier = Number.parseInt(parts[1] ?? "1", 10);
        const codepoint = Number.parseInt(parts[2] ?? "", 10);
        const decoded = modifiedCodepointInput(codepoint, modifier);
        if (decoded !== undefined) return { length, ...decoded };
      }
      const base = parts[0] ?? "";
      const mapped = CSI_TILDE_KEYS[base];
      return mapped !== undefined ? { length, key: mapped } : { length };
    }

    const mapped = CSI_KEYS[char];
    if (mapped === undefined) return { length };

    // A modifier parameter, e.g. `Esc [ 1 ; 5 A` for Ctrl+Up.
    const modifier = Number.parseInt(parameters.split(";")[1] ?? "", 10);
    if (Number.isInteger(modifier) && modifier > 1) {
      const prefix = modifierPrefix(modifier);
      return { length, key: `${prefix}${mapped}` };
    }
    return { length, key: mapped };
  }

  return undefined;
}

/**
 * Parse the SGR mouse parameters `button ; column ; row` into a MouseEvent.
 *
 * The SGR format uses 1-based coordinates; we normalize to 0-based to match the
 * rest of the TUI's row/column model. The button encodes the button itself plus
 * modifier flags in its top three bits (shift=4, alt=8, ctrl=16). Bit 5 marks
 * motion, while bit 6 marks a wheel event (64 = up, 65 = down). Keep the wheel
 * bit in the public button value so the UI can distinguish scrolling from a
 * left-button press; motion is normalized to its underlying button instead.
 */
function parseSgrMouse(parameters: string, pressed: boolean): MouseEvent | undefined {
  const parts = parameters.split(";");
  if (parts.length < 3) return undefined;
  const buttonRaw = Number.parseInt(parts[0] ?? "", 10);
  const column = Number.parseInt(parts[1] ?? "", 10) - 1;
  const row = Number.parseInt(parts[2] ?? "", 10) - 1;
  if (!Number.isInteger(buttonRaw) || !Number.isInteger(column) || !Number.isInteger(row)) {
    return undefined;
  }
  const baseButton = buttonRaw & 3;
  const isWheel = (buttonRaw & 0x40) !== 0;
  return {
    kind: "mouse",
    button: isWheel ? 64 + baseButton : baseButton,
    column,
    row,
    shift: (buttonRaw & 4) !== 0,
    alt: (buttonRaw & 8) !== 0,
    ctrl: (buttonRaw & 16) !== 0,
    pressed,
  };
}

/** Decode Kitty CSI-u and xterm modifyOtherKeys codepoints. */
function modifiedCodepointInput(
  codepoint: number,
  modifier: number,
): { readonly key: string; readonly text?: string } | undefined {
  if (!Number.isInteger(codepoint) || codepoint < 0 || codepoint > 0x10ffff) return undefined;
  if (codepoint >= 0xd800 && codepoint <= 0xdfff) return undefined;
  const prefix =
    Number.isInteger(modifier) && modifier > 1
      ? modifierPrefix(modifier)
      : "";
  const base =
    codepoint === 13 || codepoint === 10
      ? "enter"
      : codepoint === 9
        ? "tab"
        : codepoint === 27
          ? "escape"
          : codepoint === 127
            ? "backspace"
            : undefined;
  if (base !== undefined) return { key: `${prefix}${base}` };

  if (codepoint < 0x20) return undefined;
  const text = String.fromCodePoint(codepoint);
  if (prefix.length === 0) return { key: "text", text };
  return { key: `${prefix}${text.toLowerCase()}` };
}

function modifierPrefix(modifier: number): string {
  // xterm encodes the modifier as a bitmask offset by one.
  const bits = modifier - 1;
  const parts: string[] = [];
  if ((bits & 4) !== 0) parts.push("ctrl");
  if ((bits & 2) !== 0) parts.push("alt");
  if ((bits & 1) !== 0) parts.push("shift");
  return parts.length > 0 ? `${parts.join("+")}+` : "";
}

/**
 * A long-lived reader that turns stdin into key events.
 *
 * Owns raw mode for as long as it runs, which is what makes `Esc` reach the agent
 * *while a turn is in flight* (§7.7). The previous shape — raw mode only while a
 * prompt was being read — meant the only interruption a running turn could observe
 * was `SIGINT`, so `Esc` did nothing until the turn was already over.
 *
 * The sink is swappable so the composer and the running-turn handler can take turns
 * owning the keyboard without two readers competing for the same bytes.
 */
export interface KeyStream {
  /** Whether a real key stream is available. False when stdin is not a TTY. */
  readonly active: boolean;
  /** Whether the stream currently owns stdin raw mode. */
  readonly running?: boolean;
  start(): void;
  stop(): void;
  setSink(sink: ((event: InputEvent) => void) | undefined): void;
}

/** A no-op stream, for a non-TTY session or a test. */
export function inertKeyStream(): KeyStream {
  return {
    active: false,
    running: false,
    start: () => undefined,
    stop: () => undefined,
    setSink: () => undefined,
  };
}
