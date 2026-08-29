/**
 * The real `Host` — PRD §7.1, §7.2, §9.3, §21.1.
 *
 * Everything that touches the outside world is concentrated here so the rest of
 * `apps/cbc` stays testable without a terminal. Two behaviours are worth calling
 * out because they are requirements rather than conveniences:
 *
 *   - `prompt({ masked: true })` puts stdin in raw mode and echoes nothing. §7.2
 *     and §9.3 forbid a key from reaching the screen, a file, or argv, and an
 *     unmasked readline would put it in the terminal scrollback.
 *   - `select` degrades to a numbered list when stdin is not a TTY, so the trust
 *     prompt still has a defined answer rather than hanging on a key that will
 *     never arrive.
 */

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

import type { ExitCode } from "./exit.ts";
import type { Host, HostFs, HostIo } from "./host.ts";
import {
  decodeKeys,
  flushPendingSequence,
  inertKeyStream,
  type InputEvent,
  type KeyDecodeState,
  type KeyEvent,
  type KeyStream,
} from "./keys.ts";

const ESC = "\u001B";

interface ClipboardSink {
  write(chunk: Uint8Array): number;
  end(): number | Promise<number>;
}

export type ClipboardInputEncoding = "utf8" | "utf16le";

export interface ClipboardCommand {
  readonly argv: readonly string[];
  readonly inputEncoding: ClipboardInputEncoding;
}

const UTF8_CLIPBOARD_INPUT: ClipboardInputEncoding = "utf8";
const UTF16LE_CLIPBOARD_INPUT: ClipboardInputEncoding = "utf16le";

export function clipboardCommands(platform: string): readonly ClipboardCommand[] {
  // `clip.exe` does not reliably interpret piped UTF-8 as Unicode. Supplying
  // UTF-16LE makes it publish CF_UNICODETEXT instead of decoding through the
  // active Windows code page, which preserves Hangul and other non-ASCII text.
  if (platform === "win32") {
    return [{ argv: ["clip.exe"], inputEncoding: UTF16LE_CLIPBOARD_INPUT }];
  }
  if (platform === "darwin") {
    return [{ argv: ["pbcopy"], inputEncoding: UTF8_CLIPBOARD_INPUT }];
  }
  // `clip.exe` is available in WSL and is the reliable fallback when OSC 52 is
  // disabled by Windows Terminal. Missing commands simply fail and the next one
  // is tried; no shell is involved, so selected text never becomes command input.
  return [
    { argv: ["wl-copy"], inputEncoding: UTF8_CLIPBOARD_INPUT },
    { argv: ["xclip", "-selection", "clipboard"], inputEncoding: UTF8_CLIPBOARD_INPUT },
    { argv: ["xsel", "--clipboard", "--input"], inputEncoding: UTF8_CLIPBOARD_INPUT },
    { argv: ["clip.exe"], inputEncoding: UTF16LE_CLIPBOARD_INPUT },
    { argv: ["/mnt/c/Windows/System32/clip.exe"], inputEncoding: UTF16LE_CLIPBOARD_INPUT },
  ];
}

/** Encode text for a clipboard command without relying on the terminal locale. */
export function encodeClipboardText(text: string, encoding: ClipboardInputEncoding): Uint8Array {
  return Buffer.from(text, encoding);
}

async function writeClipboardCommand(command: ClipboardCommand, text: string): Promise<boolean> {
  try {
    const child = Bun.spawn({
      cmd: [...command.argv],
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    });
    const stdin = child.stdin as unknown as ClipboardSink;
    stdin.write(encodeClipboardText(text, command.inputEncoding));
    await stdin.end();
    return (await child.exited) === 0;
  } catch {
    return false;
  }
}

export function selectClearSequence(choiceCount: number): string {
  const rows = Math.max(1, Math.floor(choiceCount) + 1);
  return `${ESC}[${rows}A${ESC}[0J`;
}

export interface SelectInputUpdate extends KeyDecodeState {
  readonly selected: number;
  readonly redraw: boolean;
  readonly decision?: number;
}

interface AppliedSelectEvents {
  readonly selected: number;
  readonly redraw: boolean;
  readonly decision?: number;
}

function applySelectEvents(
  events: readonly InputEvent[],
  choiceCount: number,
  initialSelected: number,
): AppliedSelectEvents {
  let selected = initialSelected;
  let redraw = false;

  const move = (offset: number): void => {
    selected = (selected + offset + choiceCount) % choiceCount;
    redraw = true;
  };

  for (const event of events) {
    if (!("key" in event)) continue;

    if (event.key === "enter" || event.key === "ctrl+j") {
      return { selected, redraw, decision: selected };
    }
    if (event.key === "escape" || event.key === "ctrl+c") {
      return { selected, redraw, decision: -1 };
    }
    if (event.key === "up") {
      move(-1);
      continue;
    }
    if (event.key === "down") {
      move(1);
      continue;
    }
    if (event.key !== "text") continue;

    for (const char of event.text ?? "") {
      if (char === "k") {
        move(-1);
        continue;
      }
      if (char === "j") {
        move(1);
        continue;
      }

      const digit = Number.parseInt(char, 10);
      if (char === String(digit) && digit >= 1 && digit <= choiceCount) {
        selected = digit - 1;
        return { selected, redraw: true, decision: selected };
      }
    }
  }

  return { selected, redraw };
}

/**
 * Decode every key in a select-menu input chunk before applying it.
 *
 * Terminals may batch Down and Enter into one data event or split an escape
 * sequence across multiple events. Comparing the raw chunk to one exact key made
 * the batched form a no-op, after which a later Enter confirmed choice 1.
 */
export function decodeSelectInput(
  chunk: string,
  choiceCount: number,
  selected: number,
  state: KeyDecodeState = {},
): SelectInputUpdate {
  const decoded = decodeKeys(chunk, state);
  const applied = applySelectEvents(decoded.events, choiceCount, selected);
  return {
    ...applied,
    ...(decoded.pendingPaste !== undefined ? { pendingPaste: decoded.pendingPaste } : {}),
    ...(decoded.pendingControl !== undefined ? { pendingControl: decoded.pendingControl } : {}),
    ...(decoded.pendingSequence !== undefined ? { pendingSequence: decoded.pendingSequence } : {}),
  };
}

type TerminalEncoding = "utf-8" | "windows-949";
type ByteStatus = "valid" | "incomplete" | "invalid";

/** Bun supports CP949 at runtime even though the DOM TextDecoder type omits it. */
function terminalDecoder(
  encoding: TerminalEncoding,
  options?: ConstructorParameters<typeof TextDecoder>[1],
): TextDecoder {
  return new TextDecoder(
    encoding as unknown as ConstructorParameters<typeof TextDecoder>[0],
    options,
  );
}

interface StrictDecode {
  readonly status: ByteStatus;
  readonly text?: string;
}

/**
 * Decode bytes from a Windows raw terminal without turning Korean IME input into
 * replacement glyphs. Windows Terminal normally emits UTF-8, while legacy console
 * hosts can still emit the active Korean code page (CP949). The first non-ASCII run
 * is probed with both decoders; once a complete sequence identifies the encoding,
 * subsequent chunks use one streaming decoder.
 */
export class TerminalInputDecoder {
  #encoding: TerminalEncoding | undefined;
  #decoder: TextDecoder | undefined;
  #probe = Buffer.alloc(0);

  decode(raw: Buffer | string): string {
    if (typeof raw === "string") return raw;
    if (this.#encoding !== undefined) {
      return (this.#decoder ??= terminalDecoder(this.#encoding)).decode(raw, { stream: true });
    }

    // ASCII is shared by UTF-8 and CP949, so it can pass through until a
    // non-ASCII run needs an encoding decision. Once a probe is pending, keep
    // every following byte with it: CP949 permits ASCII trail bytes, and an
    // ASCII byte can also prove that a tentative UTF-8 sequence was incomplete.
    const input = this.#probe.length === 0 ? raw : Buffer.concat([this.#probe, raw]);
    this.#probe = Buffer.alloc(0);

    let asciiPrefixLength = 0;
    while (asciiPrefixLength < input.length && (input[asciiPrefixLength] as number) < 0x80) {
      asciiPrefixLength += 1;
    }

    const prefix = input.subarray(0, asciiPrefixLength).toString("utf8");
    if (asciiPrefixLength === input.length) return prefix;
    return prefix + this.#decodeUnknown(input.subarray(asciiPrefixLength));
  }

  /** True while a first non-ASCII sequence still needs another byte or a flush. */
  get hasPendingInput(): boolean {
    return this.#encoding === undefined && this.#probe.length > 0;
  }

  /**
   * Resolve a probe that remained ambiguous until the terminal went idle.
   *
   * A valid CP949 pair can be the prefix of a three-byte UTF-8 character. During
   * normal input we wait for the next byte so UTF-8 wins when it completes. At an
   * idle boundary, however, that pair is a complete legacy-console character.
   */
  flush(): string {
    if (this.#encoding !== undefined) {
      return (this.#decoder ??= terminalDecoder(this.#encoding)).decode();
    }
    if (this.#probe.length === 0) return "";

    const probe = this.#probe;
    const cp949 = strictDecode("windows-949", probe);
    if (cp949.status === "valid") return this.#commit("windows-949", cp949.text);

    // If neither decoder has a completed character, expose malformed UTF-8 the
    // same way Node normally would rather than holding the composer indefinitely.
    const fallback = new TextDecoder("utf-8").decode(probe);
    this.#encoding = "utf-8";
    this.#decoder = new TextDecoder("utf-8");
    this.#probe = Buffer.alloc(0);
    return fallback;
  }

  reset(): void {
    this.#encoding = undefined;
    this.#decoder = undefined;
    this.#probe = Buffer.alloc(0);
  }

  #decodeUnknown(run: Buffer): string {
    if (this.#encoding !== undefined) {
      return (this.#decoder ??= terminalDecoder(this.#encoding)).decode(run, { stream: true });
    }

    this.#probe = Buffer.concat([this.#probe, run]);
    const utf8 = strictDecode("utf-8", this.#probe);
    const cp949 = strictDecode("windows-949", this.#probe);

    // Prefer UTF-8 whenever the complete byte run is valid. This is the normal
    // Windows Terminal path and avoids changing the meaning of emoji or CJK text.
    if (utf8.status === "valid") return this.#commit("utf-8", utf8.text);

    // Do not commit a complete CP949 pair while it is still a possible UTF-8
    // prefix. For example, the first two bytes of UTF-8 "가" (EA B0) are also a
    // valid CP949 character. Committing here produced mojibake whenever Windows
    // delivered that UTF-8 character across two raw-stream chunks.
    if (utf8.status === "incomplete") return "";

    if (cp949.status === "valid") return this.#commit("windows-949", cp949.text);

    // A split CP949 sequence is held until its trail byte arrives.
    if (cp949.status === "incomplete") return "";

    // Neither encoding accepts the bytes. Keep the stream live and let UTF-8's
    // replacement behaviour surface the malformed sequence instead of stalling
    // the composer forever.
    const fallback = new TextDecoder("utf-8").decode(this.#probe);
    this.#encoding = "utf-8";
    this.#decoder = new TextDecoder("utf-8");
    this.#probe = Buffer.alloc(0);
    return fallback;
  }

  #commit(encoding: TerminalEncoding, text = ""): string {
    this.#encoding = encoding;
    this.#decoder = terminalDecoder(encoding);
    this.#probe = Buffer.alloc(0);
    return text;
  }
}

function strictDecode(encoding: TerminalEncoding, bytes: Buffer): StrictDecode {
  try {
    return {
      status: "valid",
      text: terminalDecoder(encoding, { fatal: true }).decode(bytes),
    };
  } catch {
    const incomplete =
      encoding === "utf-8" ? isIncompleteUtf8(bytes) : isIncompleteCp949(bytes);
    return { status: incomplete ? "incomplete" : "invalid" };
  }
}

/** Whether `bytes` is a valid prefix of UTF-8 that only lacks continuation bytes. */
function isIncompleteUtf8(bytes: Buffer): boolean {
  let index = 0;
  while (index < bytes.length) {
    const lead = bytes[index] as number;
    if (lead < 0x80) {
      index += 1;
      continue;
    }

    const sequence = utf8SequenceInfo(lead);
    if (sequence === undefined) return false;
    const [length, secondMin, secondMax] = sequence;
    const available = Math.min(length - 1, bytes.length - index - 1);
    for (let offset = 1; offset <= available; offset += 1) {
      const byte = bytes[index + offset] as number;
      const valid =
        offset === 1
          ? byte >= secondMin && byte <= secondMax
          : byte >= 0x80 && byte <= 0xbf;
      if (!valid) return false;
    }

    if (available < length - 1) return true;
    index += length;
  }
  return false;
}

function utf8SequenceInfo(
  lead: number,
): readonly [length: number, secondMin: number, secondMax: number] | undefined {
  if (lead >= 0xc2 && lead <= 0xdf) return [2, 0x80, 0xbf];
  if (lead === 0xe0) return [3, 0xa0, 0xbf];
  if ((lead >= 0xe1 && lead <= 0xec) || (lead >= 0xee && lead <= 0xef)) {
    return [3, 0x80, 0xbf];
  }
  if (lead === 0xed) return [3, 0x80, 0x9f];
  if (lead === 0xf0) return [4, 0x90, 0xbf];
  if (lead >= 0xf1 && lead <= 0xf3) return [4, 0x80, 0xbf];
  if (lead === 0xf4) return [4, 0x80, 0x8f];
  return undefined;
}

function isIncompleteCp949(bytes: Buffer): boolean {
  const last = bytes.at(-1);
  return last !== undefined && last >= 0x81 && last <= 0xfe;
}

/**
 * Read stdin in raw mode and emit decoded keys.
 *
 * Raw mode stays on between prompts, so a running turn can observe `Esc`. The cost
 * is that `Ctrl+C` no longer arrives as `SIGINT` — the terminal hands us `0x03`
 * instead — which is why `apps/cbc` routes both through the same handler rather than
 * relying on a signal.
 */
function createKeyStream(): KeyStream {
  const stdin = process.stdin;
  if (stdin.isTTY !== true) return inertKeyStream();

  let sink: ((event: InputEvent) => void) | undefined;
  let running = false;
  let wasRaw = false;
  let pendingPaste: string | undefined;
  let pendingControl: string | undefined;
  let pendingSequence: string | undefined;
  let escapeTimer: ReturnType<typeof setTimeout> | undefined;
  let inputFlushTimer: ReturnType<typeof setTimeout> | undefined;
  const inputDecoder = new TerminalInputDecoder();

  const disarmEscapeTimer = (): void => {
    if (escapeTimer === undefined) return;
    clearTimeout(escapeTimer);
    escapeTimer = undefined;
  };

  const disarmInputFlushTimer = (): void => {
    if (inputFlushTimer === undefined) return;
    clearTimeout(inputFlushTimer);
    inputFlushTimer = undefined;
  };

  const dispatchDecodedInput = (chunk: string): void => {
    if (chunk.length === 0) return;
    disarmEscapeTimer();
    const decoded = decodeKeys(chunk, {
      ...(pendingPaste !== undefined ? { pendingPaste } : {}),
      ...(pendingControl !== undefined ? { pendingControl } : {}),
      ...(pendingSequence !== undefined ? { pendingSequence } : {}),
    });
    pendingPaste = decoded.pendingPaste;
    pendingControl = decoded.pendingControl;
    pendingSequence = decoded.pendingSequence;
    for (const event of decoded.events) sink?.(event);
    // A bare `Esc` left at a chunk edge becomes a real Escape press once the
    // rest of a possible sequence does not arrive within the inter-key gap.
    // Without this, the very first `Esc` of `Esc Esc` would wait forever for
    // a second byte that is never sent (P1-01).
    if (pendingSequence === "\u001B") {
      escapeTimer = setTimeout(() => {
        escapeTimer = undefined;
        pendingSequence = undefined;
        const flushed = flushPendingSequence({ pendingSequence: "\u001B" });
        for (const event of flushed.events) sink?.(event);
      }, 35);
      (escapeTimer as unknown as { unref?: () => void }).unref?.();
    }
  };

  const armInputFlush = (): void => {
    disarmInputFlushTimer();
    if (!inputDecoder.hasPendingInput) return;
    // Terminal bytes for one key normally arrive together. A short idle boundary
    // lets legacy CP949 pairs finish while keeping UTF-8 continuation bytes ahead
    // of the decision.
    inputFlushTimer = setTimeout(() => {
      inputFlushTimer = undefined;
      dispatchDecodedInput(inputDecoder.flush());
    }, 16);
    (inputFlushTimer as unknown as { unref?: () => void }).unref?.();
  };

  const onData = (raw: Buffer | string): void => {
    disarmInputFlushTimer();
    dispatchDecodedInput(inputDecoder.decode(raw));
    armInputFlush();
  };

  return {
    active: true,
    get running(): boolean {
      return running;
    },
    start(): void {
      if (running) return;
      running = true;
      wasRaw = stdin.isRaw === true;
      stdin.setRawMode(true);
      // OpenTUI and earlier prompts may have enabled a string decoder on the
      // shared stream. Keep this reader on raw terminal bytes; the decoder above
      // waits for a complete UTF-8/CP949 sequence before dispatching Hangul.
      (stdin as NodeJS.ReadStream & { setEncoding(encoding: BufferEncoding | null): void }).setEncoding(null);
      inputDecoder.reset();
      stdin.resume();
      stdin.on("data", onData);
      // §6.14: bracketed paste, so a multi-line paste arrives as one event and its
      // newlines cannot submit the prompt.
      process.stdout.write("\u001B[?2004h");
    },
    stop(): void {
      if (!running) return;
      running = false;
      disarmEscapeTimer();
      disarmInputFlushTimer();
      pendingSequence = undefined;
      process.stdout.write("\u001B[?2004l");
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      inputDecoder.reset();
    },
    setSink(next): void {
      sink = next;
    },
  };
}

/** Format the exact cross-runtime trust identity without narrowing 64-bit file indexes. */
export function formatFilesystemIdentity(device: bigint, inode: bigint): string | undefined {
  if (device === 0n && inode === 0n) return undefined;
  return `${device}:${inode}`;
}

class NodeHostFs implements HostFs {
  async read(path: string): Promise<string | undefined> {
    try {
      return await readFile(path, "utf8");
    } catch {
      // Absent and unreadable are the same answer to every caller here: there is
      // no content. A permission problem surfaces on the write path instead,
      // where it is actionable.
      return undefined;
    }
  }

  async readPrefix(path: string, maxBytes: number): Promise<{ content: string; truncated: boolean } | undefined> {
    const limit = Math.max(0, Math.floor(maxBytes));
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, "r");
      // One extra byte distinguishes an exact-length file from a truncated read.
      const buffer = Buffer.allocUnsafe(limit + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return {
        content: buffer.subarray(0, Math.min(bytesRead, limit)).toString("utf8"),
        truncated: bytesRead > limit,
      };
    } catch {
      return undefined;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async writeBytes(path: string, content: Uint8Array): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }

  async write(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }

  async writeNew(path: string, content: string): Promise<boolean> {
    await mkdir(dirname(path), { recursive: true });
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, "wx", 0o600);
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      return true;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        return false;
      }
      throw error;
    }
  }

  async atomicWrite(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, path);

      // POSIX durability requires the directory entry to be synced after the
      // atomic rename. Windows does not permit opening directories this way.
      if (process.platform !== "win32") {
        const directory = await open(dirname(path), "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async list(path: string): Promise<string[]> {
    try {
      return await readdir(path);
    } catch {
      return [];
    }
  }

  async mkdirp(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }

  async remove(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  }

  async isDirectory(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  }

  async realpath(path: string): Promise<string | undefined> {
    try {
      return (await realpath(path)).replace(/\\/g, "/");
    } catch {
      return undefined;
    }
  }

  /**
   * §13.6 filesystem identity, mirroring `cbc_workspace::trust::filesystem_id`:
   * `dev:ino` on Unix and the equivalent volume/file identity on Windows.
   * A missing or all-zero identity fails closed.
   */
  async statIdentity(path: string): Promise<string | undefined> {
    try {
      // Windows file indexes are 64-bit values and regularly exceed Number's exact
      // integer range. The Rust trust authority serializes the complete u64, so a
      // rounded host value would silently downgrade a legitimately trusted workspace
      // to read-only. BigInt stats preserve the shared `volume:file-index` identity.
      const meta = await stat(path, { bigint: true });
      return formatFilesystemIdentity(meta.dev, meta.ino);
    } catch {
      return undefined;
    }
  }
}

class NodeHostIo implements HostIo {
  readonly #out = process.stdout;
  readonly #err = process.stderr;
  #stream: KeyStream | undefined;

  stdout(text: string): boolean {
    return this.#out.write(text);
  }

  /**
   * The session-long key reader (§6.14, §7.7).
   *
   * One instance per process: two readers on the same stdin would each see half the
   * bytes, which is how an arrow key becomes a stray `escape` and cancels a turn.
   */
  keyStream(): KeyStream {
    this.#stream ??= createKeyStream();
    return this.#stream;
  }

  stderr(text: string): void {
    this.#err.write(text);
  }

  async copyToClipboard(text: string): Promise<boolean> {
    for (const command of clipboardCommands(process.platform)) {
      if (await writeClipboardCommand(command, text)) return true;
    }
    return false;
  }

  get isTty(): boolean {
    return this.#out.isTTY === true;
  }

  get columns(): number {
    return this.#out.columns ?? 80;
  }

  get rows(): number {
    return this.#out.rows ?? 24;
  }

  async readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  async *readLines(): AsyncIterable<string> {
    let buffer = "";
    for await (const chunk of process.stdin) {
      buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        yield buffer.slice(0, newline).replace(/\r$/u, "");
        buffer = buffer.slice(newline + 1);
      }
    }
    if (buffer.length > 0) yield buffer.replace(/\r$/u, "");
  }

  async prompt(question: string, options: { masked?: boolean } = {}): Promise<string> {
    const masked = options.masked === true;
    this.#err.write(question);

    const stdin = process.stdin;
    if (!stdin.isTTY) {
      // Non-interactive: consume one line from the pipe. §8.3 forbids blocking on
      // a prompt in headless mode, and callers gate on `isTty` before asking, so
      // reaching here means a line was piped deliberately.
      const all = await this.readStdin();
      const line = all.split("\n", 1)[0] ?? "";
      return line.replace(/\r$/, "");
    }

    return await new Promise<string>((resolvePrompt, rejectPrompt) => {
      let buffer = "";
      const wasRaw = stdin.isRaw === true;
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding("utf8");

      const finish = (value: string | undefined, error?: Error): void => {
        stdin.removeListener("data", onData);
        stdin.setRawMode(wasRaw);
        stdin.pause();
        this.#err.write("\n");
        if (error) rejectPrompt(error);
        else resolvePrompt(value ?? "");
      };

      const onData = (raw: string): void => {
        for (const char of raw) {
          switch (char) {
            case "\r":
            case "\n":
              finish(buffer);
              return;
            case "\u0003": // Ctrl+C
              finish(undefined, new Error("cancelled"));
              return;
            case "\u0004": // Ctrl+D
              finish(buffer);
              return;
            case "\u007F": // Backspace
            case "\b":
              if (buffer.length > 0) {
                buffer = buffer.slice(0, -1);
                if (!masked) this.#err.write("\b \b");
              }
              break;
            default: {
              const code = char.codePointAt(0) ?? 0;
              // Drop control characters so a pasted escape sequence cannot be
              // treated as input (§24.4 T6).
              if (code < 0x20) break;
              buffer += char;
              this.#err.write(masked ? "•" : char);
            }
          }
        }
      };

      stdin.on("data", onData);
    });
  }

  async select(question: string, choices: readonly string[]): Promise<number> {
    if (choices.length === 0) return -1;

    const stdin = process.stdin;
    if (!stdin.isTTY) {
      // §7.1's first-run choice still needs an answer without a keyboard. A
      // number on stdin is unambiguous; anything else cancels.
      this.#err.write(`${question}\n`);
      choices.forEach((choice, index) => this.#err.write(`  ${index + 1}) ${choice}\n`));
      const answer = (await this.prompt("Choice: ")).trim();
      const parsed = Number.parseInt(answer, 10);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > choices.length) return -1;
      return parsed - 1;
    }

    let selected = 0;
    const hasQuestion = question.length > 0;
    const draw = (first: boolean): void => {
      const lineCount = choices.length + 2 + (hasQuestion ? 1 : 0);
      const rewind = first ? "" : `${ESC}[${lineCount}A`;
      const rows = choices.map((choice, index) => {
        if (index === selected) {
          return `${ESC}[2K\x1b[36m❯ \x1b[1;36m${choice}\x1b[0m`;
        }
        return `${ESC}[2K\x1b[90m  ${choice}\x1b[0m`;
      });
      const qHeader = hasQuestion ? `${ESC}[2K\x1b[1;37m? \x1b[1m${question}\x1b[0m\n` : "";
      const hintFooter = `${ESC}[2K\x1b[90mEnter to confirm  ·  Esc to exit\x1b[0m`;
      this.#err.write(`${rewind}${qHeader}${rows.join("\n")}\n\n${hintFooter}\n`);
    };

    // Hide cursor during interactive select menu to prevent cursor blinking
    this.#err.write("\u001B[?25l");
    draw(true);

    return await new Promise<number>((resolveSelect) => {
      const wasRaw = stdin.isRaw === true;
      let keyState: KeyDecodeState = {};
      let escapeTimer: ReturnType<typeof setTimeout> | undefined;
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding("utf8");

      const disarmEscapeTimer = (): void => {
        if (escapeTimer === undefined) return;
        clearTimeout(escapeTimer);
        escapeTimer = undefined;
      };

      const finish = (index: number): void => {
        disarmEscapeTimer();
        stdin.removeListener("data", onData);
        stdin.setRawMode(wasRaw);
        // Restore cursor visibility
        this.#err.write("\u001B[?25h");
        // The picker is a transient surface. Move back over its question and rows,
        // then clear them before the full-screen UI paints again. Leaving these on
        // stderr made a completed model selection look permanently open because
        // OpenTUI owns stdout and could not reliably overwrite the other stream.
        this.#err.write(selectClearSequence(choices.length));
        // `InputReader` keeps one key stream alive for the whole session. A
        // standalone select normally pauses stdin when it finishes, but doing that
        // here would leave the next prompt waiting on a paused stream.
        if (this.#stream?.running === true) stdin.resume();
        else stdin.pause();
        resolveSelect(index);
      };

      const applyUpdate = (update: SelectInputUpdate): void => {
        selected = update.selected;
        keyState = {
          ...(update.pendingPaste !== undefined ? { pendingPaste: update.pendingPaste } : {}),
          ...(update.pendingControl !== undefined ? { pendingControl: update.pendingControl } : {}),
          ...(update.pendingSequence !== undefined ? { pendingSequence: update.pendingSequence } : {}),
        };
        if (update.redraw) draw(false);
        if (update.decision !== undefined) {
          finish(update.decision);
          return;
        }

        if (update.pendingSequence === ESC) {
          escapeTimer = setTimeout(() => {
            escapeTimer = undefined;
            const flushed = flushPendingSequence(keyState);
            keyState = {};
            applyUpdate(applySelectEvents(flushed.events, choices.length, selected));
          }, 35);
          (escapeTimer as unknown as { unref?: () => void }).unref?.();
        }
      };

      const onData = (raw: string): void => {
        disarmEscapeTimer();
        applyUpdate(decodeSelectInput(raw, choices.length, selected, keyState));
      };

      stdin.on("data", onData);
    });
  }
}

/** Interpreter names that mean "running from source" rather than a compiled binary. */
const INTERPRETERS = new Set(["bun", "bun.exe", "bun-debug", "bun-debug.exe", "node", "node.exe"]);

/**
 * Directory holding the running executable — §19.2's anchor for the sidecar.
 *
 * Inside a `bun build --compile` binary, `process.argv[1]` is a *virtual* path into the
 * embedded bundle, so deriving `libexec/` from it produced a location that does not
 * exist: a released `capy` could not find `cbc-runtime` sitting right beside it.
 * `process.execPath` is the real file in that case.
 *
 * In a checkout the reverse holds — `execPath` is the Bun interpreter, which says nothing
 * about where the project is — so `argv[1]` is used. The interpreter's own name is the
 * signal that distinguishes the two.
 */
function resolveExecutableDir(): string {
  const execPath = process.execPath;
  const execName = execPath.replace(/\\/g, "/").split("/").pop() ?? "";

  if (!INTERPRETERS.has(execName.toLowerCase())) {
    // A compiled executable: its own directory is `bin/`, and `libexec/` is its sibling.
    return dirname(resolve(execPath)).replace(/\\/g, "/");
  }

  const argv1 = process.argv[1];
  if (argv1 !== undefined && argv1.length > 0) {
    return dirname(resolve(argv1)).replace(/\\/g, "/");
  }
  return process.cwd().replace(/\\/g, "/");
}

/** Build the production host. */
export function createBunHost(version: string): Host {
  const io = new NodeHostIo();
  const fs = new NodeHostFs();

  return {
    io,
    fs,
    env: process.env as Readonly<Record<string, string | undefined>>,
    cwd: process.cwd().replace(/\\/g, "/"),
    homeDir: (process.env.HOME ?? process.env.USERPROFILE ?? process.cwd()).replace(/\\/g, "/"),
    platform: process.platform,
    version,
    // §19.2: the runtime is found relative to this executable, never through `PATH`.
    executableDir: resolveExecutableDir(),
    now: () => Date.now(),
    exit: (code: ExitCode): never => {
      process.exit(code);
    },
  };
}
