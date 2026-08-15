/**
 * Native OpenTUI surface for the full-screen Capybara session.
 *
 * The domain renderers still produce semantic StyledLine values. This adapter maps
 * their design tokens to OpenTUI StyledText chunks, so the native renderer owns the
 * alternate screen, colour capability handling, layout buffer, and terminal reset.
 */

import process from "node:process";

import {
  BoxRenderable,
  createCliRenderer,
  createTextAttributes,
  RGBA,
  StyledText,
  TextRenderable,
  type CliRenderer,
  type TextChunk,
} from "@opentui/core";
import {
  THEME_TOKENS,
  TERMINAL_SETUP,
  type StyledLine,
  type Theme,
  type ThemeToken,
} from "@cbc/tui-components";

/** Let terminal capability replies drain before Capybara takes over stdin. */
const OPEN_TUI_INPUT_HANDOFF_GRACE_MS = 120;

/** A zero-based terminal cell used to anchor native IME composition windows. */
export interface TerminalCursorPosition {
  readonly column: number;
  readonly row: number;
}

export interface OpenTuiViewOptions {
  readonly theme: Theme;
  /**
   * §21.4 `ui.mouse`. Defaults on; `false` leaves the terminal's native text
   * selection working by not enabling mouse tracking (P1-02).
   */
  readonly mouse?: boolean;
  /**
   * OpenTUI must see the real terminal input while it starts so its capability
   * probes do not get echoed back into the screen. Tests may provide an inert
   * stream instead.
   */
  readonly stdin?: NodeJS.ReadStream;
  /** Injectable only for renderer-level tests; production uses process.stdout. */
  readonly stdout?: NodeJS.WriteStream;
}

export class OpenTuiView {
  readonly #renderer: CliRenderer;
  readonly #root: BoxRenderable;
  readonly #theme: Theme;
  readonly #stdout: NodeJS.WriteStream;
  readonly #rows: TextRenderable[] = [];
  readonly #rowSignatures: string[] = [];
  readonly #rowRevisions: Array<number | undefined> = [];

  readonly #detachRendererInput: () => void;
  readonly #resumeRenderer: () => void;
  private constructor(
    renderer: CliRenderer,
    root: BoxRenderable,
    theme: Theme,
    stdout: NodeJS.WriteStream,
    detachRendererInput: () => void,
    resumeRenderer: () => void,
  ) {
    this.#renderer = renderer;
    this.#root = root;
    this.#theme = theme;
    this.#stdout = stdout;
    this.#detachRendererInput = detachRendererInput;
    this.#resumeRenderer = resumeRenderer;
  }

  static async create(options: OpenTuiViewOptions): Promise<OpenTuiView> {
    // Use the terminal input during setup. OpenTUI sends colour and pixel-size
    // queries before the composer starts; a private stream left the real terminal
    // in cooked/echo mode, which made those replies appear as stray characters and
    // prevented reliable typing. Once setup is complete, Capybara's UTF-8 key stream
    // owns input and remains the only component that edits the composer.
    const stdin = options.stdin ?? process.stdin;
    const stdout = options.stdout ?? process.stdout;
    const listenersBeforeRenderer = new Set(stdin.listeners("data"));
    let renderer: CliRenderer;
    try {
      renderer = await createCliRenderer({
        stdin,
        ...(options.stdout !== undefined ? { stdout: options.stdout } : {}),
        screenMode: "alternate-screen",
        exitOnCtrlC: false,
        exitSignals: [],
        consoleMode: "disabled",
        backgroundColor: options.theme.hex("bg.base"),
        // Keep composer redraws below a keystroke rather than visibly one frame
        // behind when an IME emits committed Hangul syllables quickly.
        targetFps: 60,
        useMouse: false,
        // Keep Kitty flags at zero: Capybara owns stdin decoding and its key
        // parser expects the terminal's ordinary UTF-8/ANSI input stream.
        useKittyKeyboard: {
          disambiguate: false,
          alternateKeys: false,
        },
      });
    } catch (error) {
      throw error;
    }
    // Keep the native cursor visible from the first frame. Windows IMEs use this
    // hardware cursor as their composition anchor, and hiding it makes the first
    // committed syllable look lost even though the composer state changed.
    renderer.setCursorPosition(0, 0, true);
    // setupTerminal() sends OSC/CPR probes whose replies can arrive just after the
    // renderer promise resolves. Keep its parser attached for one short grace
    // window so those bytes cannot become the first Capybara text event.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, OPEN_TUI_INPUT_HANDOFF_GRACE_MS);
    });
    // OpenTUI installs its own 20 ms stdin parser. Keeping it subscribed alongside
    // the Capybara UTF-8 reader makes every byte go through two decoders and leaves
    // the IME waiting for the parser timeout. Detach only listeners installed by
    // this renderer; any reader that existed before it keeps ownership of input.
    const rendererInputListeners = stdin
      .listeners("data")
      .filter((listener) => !listenersBeforeRenderer.has(listener));
    const detachRendererInput = (): void => {
      for (const listener of rendererInputListeners) {
        stdin.removeListener("data", listener as (...args: any[]) => void);
      }
    };
    const resumeRenderer = (): void => {
      const listenersBeforeResume = new Set(stdin.listeners("data"));
      renderer.resume();
      for (const listener of stdin.listeners("data")) {
        if (!listenersBeforeResume.has(listener)) {
          stdin.removeListener("data", listener as (...args: any[]) => void);
        }
      }
    };
    detachRendererInput();
    // Enable SGR mouse tracking so the Capybara key decoder receives drag events.
    // OpenTUI's own `useMouse` stays off — we own stdin decoding, including mouse.
    // §21.4 `ui.mouse = false` keeps the terminal's native selection instead (P1-02).
    if (options.mouse !== false) {
      stdout.write(TERMINAL_SETUP.enableMouse);
    }
    const root = new BoxRenderable(renderer, {
      id: "capy-root",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      overflow: "hidden",
      backgroundColor: options.theme.hex("bg.base"),
      shouldFill: true,
    });
    renderer.root.add(root);

    return new OpenTuiView(renderer, root, options.theme, stdout, detachRendererInput, resumeRenderer);
  }

  render(lines: readonly StyledLine[], cursor?: TerminalCursorPosition): void {
    // Keep one native renderable per terminal row. Timeline, sidebar, composer,
    // spinner, and status mutations then update only their changed rows instead of
    // replacing one full-screen StyledText object on every frame.
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const row = this.#ensureRow(index);
      if (
        line.revision !== undefined &&
        this.#rowRevisions[index] === line.revision
      ) {
        continue;
      }
      const signature = styledLineSignature(line);
      if (
        line.revision !== undefined ||
        this.#rowSignatures[index] !== signature
      ) {
        row.content = new StyledText(toOpenTuiLineChunks(line, this.#theme));
        this.#rowSignatures[index] = signature;
      }
      this.#rowRevisions[index] = line.revision;
    }
    for (let index = lines.length; index < this.#rows.length; index += 1) {
      if (this.#rowSignatures[index] === "") continue;
      this.#rows[index]!.content = new StyledText([]);
      this.#rowSignatures[index] = "";
      this.#rowRevisions[index] = undefined;
    }

    // OpenTUI renders the composer text without a synthetic caret, so keep the
    // real terminal cursor visible and in sync. Windows IMEs anchor their
    // preedit/candidate window to this position; hiding it makes the first
    // committed Hangul syllable appear to be missing.
    if (cursor !== undefined) {
      const column = Math.max(1, Math.min(this.#renderer.width, cursor.column + 1));
      const row = Math.max(1, Math.min(this.#renderer.height, cursor.row + 1));
      this.#renderer.setCursorPosition(column, row, true);
    }
    this.#renderer.requestRender();
  }

  #ensureRow(index: number): TextRenderable {
    const existing = this.#rows[index];
    if (existing !== undefined) return existing;
    const row = new TextRenderable(this.#renderer, {
      id: `capy-row-${index}`,
      width: "100%",
      height: 1,
      wrapMode: "none",
      content: "",
    });
    this.#root.add(row);
    this.#rows.push(row);
    this.#rowSignatures.push("");
    this.#rowRevisions.push(undefined);
    return row;
  }

  /** The native renderer is the source of truth after terminal setup and resize. */
  get columns(): number {
    return this.#renderer.width;
  }

  get rows(): number {
    return this.#renderer.height;
  }

  onResize(listener: (columns: number, rows: number) => void): () => void {
    this.#renderer.on("resize", listener);
    return () => this.#renderer.off("resize", listener);
  }

  /** Clear native renderable content and stdout buffer for crisp resizes. */
  clear(): void {
    try {
      for (let index = 0; index < this.#rows.length; index += 1) {
        this.#rows[index]!.content = new StyledText([]);
        this.#rowSignatures[index] = "";
        this.#rowRevisions[index] = undefined;
      }
      this.#renderer.requestRender();
      this.#stdout.write("\u001B[2J\u001B[3J\u001B[H");
    } catch {
      // Best-effort terminal screen clear
    }
  }

  /** Temporarily yield terminal ownership to a native prompt or picker. */
  suspend(): void {
    this.#renderer.suspend();
  }

  /** Reacquire the terminal and force the next semantic frame to be painted. */
  resume(): void {
    this.#resumeRenderer();
    this.#detachRendererInput();
    this.#renderer.requestRender();
  }

  destroy(): void {
    this.#detachRendererInput();
    try {
      this.#stdout.write(TERMINAL_SETUP.disableMouse);
    } catch {
      // The renderer may already be torn down; the restore sequence covers this.
    }
    if (!this.#renderer.isDestroyed) this.#renderer.destroy();
  }
}

const THEME_COLOR_CACHE = new WeakMap<Theme, Record<ThemeToken, RGBA>>();
const TEXT_ATTRIBUTE_CACHE = new Map<number, number>();

function colorsFor(theme: Theme): Record<ThemeToken, RGBA> {
  const cached = THEME_COLOR_CACHE.get(theme);
  if (cached !== undefined) return cached;
  const colors = Object.fromEntries(
    THEME_TOKENS.map((token) => [token, RGBA.fromHex(theme.hex(token))]),
  ) as Record<ThemeToken, RGBA>;
  THEME_COLOR_CACHE.set(theme, colors);
  return colors;
}

function attributeMask(segment: StyledLine["segments"][number]): number {
  return (
    (segment.bold === true ? 1 : 0) |
    (segment.italic === true ? 2 : 0) |
    (segment.dim === true ? 4 : 0) |
    (segment.underline === true ? 8 : 0) |
    (segment.inverse === true ? 16 : 0)
  );
}

function attributesFor(segment: StyledLine["segments"][number]): number {
  const mask = attributeMask(segment);
  const cached = TEXT_ATTRIBUTE_CACHE.get(mask);
  if (cached !== undefined) return cached;
  const attributes = createTextAttributes({
    ...(segment.bold === true ? { bold: true } : {}),
    ...(segment.italic === true ? { italic: true } : {}),
    ...(segment.dim === true ? { dim: true } : {}),
    ...(segment.underline === true ? { underline: true } : {}),
    ...(segment.inverse === true ? { inverse: true } : {}),
  });
  TEXT_ATTRIBUTE_CACHE.set(mask, attributes);
  return attributes;
}

function styledLineSignature(line: StyledLine): string {
  return JSON.stringify([
    line.rowBackground ?? "",
    line.segments.map((segment) => [
      segment.text,
      segment.fg ?? "fg.primary",
      segment.bg ?? "",
      attributeMask(segment),
    ]),
  ]);
}

function toOpenTuiLineChunks(styled: StyledLine, theme: Theme): TextChunk[] {
  const colors = colorsFor(theme);
  return styled.segments.map((segment) => {
    const attributes = attributesFor(segment);
    const background = segment.bg ?? styled.rowBackground;
    return {
      __isChunk: true,
      text: segment.text,
      fg: colors[segment.fg ?? "fg.primary"],
      ...(background !== undefined ? { bg: colors[background] } : {}),
      ...(attributes !== 0 ? { attributes } : {}),
    };
  });
}

export function toOpenTuiChunks(lines: readonly StyledLine[], theme: Theme): TextChunk[] {
  const chunks: TextChunk[] = [];
  for (const [lineIndex, styled] of lines.entries()) {
    chunks.push(...toOpenTuiLineChunks(styled, theme));
    if (lineIndex < lines.length - 1) chunks.push({ __isChunk: true, text: "\n" });
  }
  return chunks;
}
