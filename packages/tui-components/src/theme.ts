/**
 * Theme and colour fallbacks — PRD §6.5, §6.6, §6.20, AC-45.
 *
 * §6.5's rules are the whole design here:
 *
 * - a 256-colour fallback exists
 * - a 16-colour fallback exists
 * - `NO_COLOR` keeps meaning through icon, label, and indentation
 * - **colour never carries state on its own**
 *
 * That last rule is why every block renderer in this package emits an icon and a
 * label beside its colour. AC-45 tests exactly that: with `NO_COLOR=1` the output
 * must still distinguish every state.
 */

/** §6.5 semantic tokens. */
export type ThemeToken =
  | "bg.base"
  | "bg.panel"
  | "bg.user"
  | "bg.task"
  | "fg.primary"
  | "fg.muted"
  | "accent.coral"
  | "accent.amber"
  | "accent.green"
  | "accent.cyan"
  | "accent.red"
  | "accent.purple"
  | "accent.blue"
  | "border.warm";

export const THEME_TOKENS: readonly ThemeToken[] = [
  "bg.base",
  "bg.panel",
  "bg.user",
  "bg.task",
  "fg.primary",
  "fg.muted",
  "accent.coral",
  "accent.amber",
  "accent.green",
  "accent.cyan",
  "accent.red",
  "accent.purple",
  "accent.blue",
  "border.warm",
];

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/**
 * A background token may opt out of being painted at all.
 *
 * §6.5 says colour must never carry state alone, and the corollary the 2026.7
 * redesign leans on is that a *block* of colour must never carry it either. A
 * full-width tinted slab behind every user message reads as an alert rather than
 * as attribution, so `bg.user` resolves to nothing and a vertical accent rule
 * does the attributing instead (§6.7).
 */
export const TRANSPARENT = "transparent";

export const TOKYO_NIGHT_PALETTE: Readonly<Record<ThemeToken, string>> = {
  "bg.base": "#0d0e14",
  "bg.panel": "#1a1b26",
  "bg.user": TRANSPARENT,
  "bg.task": "#292e42",
  "fg.primary": "#c0caf5",
  "fg.muted": "#565f89",
  "accent.coral": "#7aa2f7",
  "accent.amber": "#e0af68",
  "accent.green": "#9ece6a",
  "accent.cyan": "#7dcfff",
  "accent.red": "#f7768e",
  "accent.purple": "#bb9af7",
  "accent.blue": "#7aa2f7",
  "border.warm": "#292e42",
};

/** §6.5's original truecolor values, kept so a user can pin the old look. */
export const CAPYBARA_DARK: Readonly<Record<ThemeToken, string>> = {
  "bg.base": "#111217",
  "bg.panel": "#1A1C24",
  "bg.user": "#1E202C",
  "bg.task": "#222532",
  "fg.primary": "#F1F3F9",
  "fg.muted": "#8C92A4",
  "accent.coral": "#ff5b38",
  "accent.amber": "#F0B43C",
  "accent.green": "#36D399",
  "accent.cyan": "#60A5FA",
  "accent.red": "#F87171",
  "accent.purple": "#C084FC",
  "accent.blue": "#E59866",
  "border.warm": "#2D313E",
};

/**
 * The 2026.7 Capybara Gold palette: warm obsidian black, crisp slate type, warm capybara gold accent.
 */
export const CAPYBARA_2026_THEME: Readonly<Record<ThemeToken, string>> = {
  "bg.base": "#111217",
  "bg.panel": "#1A1C24",
  "bg.user": TRANSPARENT,
  "bg.task": "#222532",
  "fg.primary": "#F1F3F9",
  "fg.muted": "#8C92A4",
  "accent.coral": "#E59866",
  "accent.amber": "#F0B43C",
  "accent.green": "#36D399",
  "accent.cyan": "#60A5FA",
  "accent.red": "#F87171",
  "accent.purple": "#C084FC",
  "accent.blue": "#E59866",
  "border.warm": "#2D313E",
};

export const OPENCODE_THEME: Readonly<Record<ThemeToken, string>> = TOKYO_NIGHT_PALETTE;

export const TOKYO_NIGHT_THEME: Readonly<Record<ThemeToken, string>> = TOKYO_NIGHT_PALETTE;

/** Named palettes selectable from `[tui] theme` in config (§21.4). */
export const THEME_PALETTES: Readonly<Record<string, Readonly<Record<ThemeToken, string>>>> = {
  "opencode": OPENCODE_THEME,
  "tokyo-night": TOKYO_NIGHT_THEME,
  "capybara-2026": CAPYBARA_2026_THEME,
  "capybara-dark": CAPYBARA_DARK,
};

/** The palette a session starts with when config names none. */
export const DEFAULT_PALETTE_NAME = "opencode";

export function palette(name: string): Readonly<Record<ThemeToken, string>> | undefined {
  return THEME_PALETTES[name];
}

export type ColorDepth = "truecolor" | "256" | "16" | "none";

export interface TerminalCapabilities {
  readonly colorDepth: ColorDepth;
  /** Whether italic is likely to render. §6.6 falls back to dim when not. */
  readonly italic: boolean;
  readonly unicode: boolean;
  /** §6.6: some terminals render emoji at an unpredictable width. */
  readonly stableEmojiWidth: boolean;
  readonly reducedMotion: boolean;
  readonly mouse: boolean;
  readonly columns: number;
  readonly rows: number;
  /** §6.20: OSC 8 hyperlinks need an explicit allowlist. */
  readonly hyperlinks: boolean;
}

export interface CapabilityEnv {
  readonly NO_COLOR?: string | undefined;
  readonly FORCE_COLOR?: string | undefined;
  readonly TERM?: string | undefined;
  readonly COLORTERM?: string | undefined;
  readonly TERM_PROGRAM?: string | undefined;
  /** Set by Windows Terminal even though POSIX locale variables are usually absent. */
  readonly WT_SESSION?: string | undefined;
  readonly CI?: string | undefined;
  readonly LANG?: string | undefined;
  readonly LC_ALL?: string | undefined;
  readonly CBC_REDUCED_MOTION?: string | undefined;
}

/**
 * Detect what the terminal can do.
 *
 * `NO_COLOR` wins over `FORCE_COLOR`: the former is a user telling us not to, the
 * latter is usually a tool guessing on their behalf.
 */
export function detectCapabilities(
  env: CapabilityEnv,
  options: { columns?: number; rows?: number; isTty?: boolean; platform?: string } = {},
): TerminalCapabilities {
  const term = env.TERM ?? "";
  const isTty = options.isTty ?? true;
  const terminalProgram = env.TERM_PROGRAM ?? "";
  const modernTerminal =
    terminalProgram === "iTerm.app" || terminalProgram === "vscode" || terminalProgram === "WezTerm";
  const windowsTerminal = env.WT_SESSION !== undefined && env.WT_SESSION !== "";
  const nativeWindowsTty = options.platform === "win32" && isTty;

  let colorDepth: ColorDepth;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") {
    colorDepth = "none";
  } else if (term === "dumb" || !isTty) {
    colorDepth = "none";
  } else if ((env.COLORTERM ?? "").includes("truecolor") || (env.COLORTERM ?? "").includes("24bit")) {
    colorDepth = "truecolor";
  } else if (modernTerminal || windowsTerminal || nativeWindowsTty) {
    colorDepth = "truecolor";
  } else if (term.includes("256")) {
    colorDepth = "256";
  } else if (term.length > 0) {
    colorDepth = "16";
  } else {
    colorDepth = "none";
  }

  if (env.FORCE_COLOR !== undefined && colorDepth === "none" && (env.NO_COLOR ?? "") === "") {
    colorDepth = env.FORCE_COLOR === "3" ? "truecolor" : env.FORCE_COLOR === "2" ? "256" : "16";
  }

  const locale = `${env.LC_ALL ?? ""}${env.LANG ?? ""}`.toLowerCase();
  // Native Windows terminals do not normally expose LANG/LC_ALL (and hosts other
  // than Windows Terminal may omit WT_SESSION), but Bun writes Unicode to their
  // TTYs. TERM_PROGRAM is the equivalent signal for other modern hosts.
  const unicode =
    locale.includes("utf") ||
    locale.includes("utf8") ||
    locale.includes("utf-8") ||
    modernTerminal ||
    windowsTerminal ||
    nativeWindowsTty;

  return {
    colorDepth,
    // §6.6: `tmux` and `screen` frequently drop italic, so dim is the safer choice.
    italic: colorDepth !== "none" && !term.startsWith("screen") && !term.startsWith("tmux"),
    unicode,
    // Emoji width is unreliable outside a handful of known-good terminals.
    stableEmojiWidth: env.TERM_PROGRAM === "iTerm.app" || env.TERM_PROGRAM === "WezTerm",
    reducedMotion:
      (env.CBC_REDUCED_MOTION !== undefined && env.CBC_REDUCED_MOTION !== "") ||
      (env.CI !== undefined && env.CI !== ""),
    mouse: false,
    columns: options.columns ?? 80,
    rows: options.rows ?? 24,
    hyperlinks: false,
  };
}

export function parseHex(hex: string): Rgb | undefined {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (match === null) return undefined;
  const value = Number.parseInt(match[1] as string, 16);
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

/** Relative luminance, for the §6.5 contrast warning. */
export function luminance(color: Rgb): number {
  const channel = (raw: number): number => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** WCAG contrast ratio between two colours. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const light = Math.max(luminance(a), luminance(b));
  const dark = Math.min(luminance(a), luminance(b));
  return (light + 0.05) / (dark + 0.05);
}

/** Map a colour to the xterm 256 cube (§6.5's 256-colour fallback). */
export function toXterm256(color: Rgb): number {
  // Greyscale ramp first: it is more accurate for the neutral tones §6.5 uses.
  const minimum = Math.min(color.r, color.g, color.b);
  const maximum = Math.max(color.r, color.g, color.b);
  if (maximum - minimum <= 16) {
    const neutral = Math.round((color.r + color.g + color.b) / 3);
    if (neutral < 8) return 16;
    if (neutral > 248) return 231;
    return Math.round(((neutral - 8) / 247) * 24) + 232;
  }
  const level = (value: number): number => Math.round((value / 255) * 5);
  return 16 + 36 * level(color.r) + 6 * level(color.g) + level(color.b);
}

/**
 * Map a colour to the 16-colour palette (§6.5's 16-colour fallback).
 *
 * Returns an SGR code in 30–37 or 90–97. The mapping is by hue dominance rather
 * than nearest-distance, because the point is to keep *semantics* legible: coral
 * must stay recognisably red-ish, green must stay green.
 */
export function toAnsi16(color: Rgb): number {
  const { r, g, b } = color;
  const max = Math.max(r, g, b);
  const bright = max > 160;
  const base = bright ? 90 : 30;

  if (max < 40) return base + 0; // black
  if (max > 215 && r > 200 && g > 200 && b > 200) return base + 7; // white

  const threshold = max * 0.72;
  const hasR = r >= threshold;
  const hasG = g >= threshold;
  const hasB = b >= threshold;

  if (hasR && hasG && hasB) return base + 7;
  if (hasR && hasG) return base + 3; // yellow
  if (hasR && hasB) return base + 5; // magenta
  if (hasG && hasB) return base + 6; // cyan
  if (hasR) return base + 1; // red
  if (hasG) return base + 2; // green
  if (hasB) return base + 4; // blue
  return base + 7;
}

export interface ThemeIssue {
  readonly token: ThemeToken;
  readonly message: string;
}

/**
 * A resolved theme: token → colour, plus how to emit it for this terminal.
 */
export class Theme {
  readonly name: string;
  readonly depth: ColorDepth;
  readonly issues: ThemeIssue[];
  readonly #colors: Record<ThemeToken, Rgb>;
  readonly #transparent: Set<ThemeToken>;

  constructor(options: {
    name?: string;
    depth: ColorDepth;
    /** Base palette. Defaults to the 2026.7 theme. */
    palette?: Readonly<Record<ThemeToken, string>>;
    overrides?: Readonly<Partial<Record<ThemeToken, string>>>;
  }) {
    const base = options.palette ?? OPENCODE_THEME;
    this.name = options.name ?? (base === CAPYBARA_DARK ? "capybara-dark" : DEFAULT_PALETTE_NAME);
    this.depth = options.depth;
    this.issues = [];

    const colors = {} as Record<ThemeToken, Rgb>;
    const transparent = new Set<ThemeToken>();

    for (const token of THEME_TOKENS) {
      const declared = options.overrides?.[token] ?? base[token];
      const isOverride = options.overrides?.[token] !== undefined;

      if (declared === TRANSPARENT) {
        // Only a background can be transparent; a transparent foreground would be
        // invisible text, which is a config mistake rather than a style choice.
        if (token.startsWith("bg.")) {
          transparent.add(token);
          // Resolve to the base surface so contrast maths and `hex()` still work.
          colors[token] = parseHex(base["bg.base"]) ?? { r: 0, g: 0, b: 0 };
          continue;
        }
        this.issues.push({
          token,
          message: `'transparent' is only meaningful for a bg.* token; the default was kept`,
        });
        colors[token] = parseHex(base[token]) ?? { r: 0, g: 0, b: 0 };
        continue;
      }

      const parsed = parseHex(declared);
      if (parsed === undefined && isOverride) {
        this.issues.push({
          token,
          message: `'${declared}' is not a #rrggbb colour; the default was kept`,
        });
      }
      colors[token] = parsed ?? (parseHex(base[token]) as Rgb) ?? { r: 0, g: 0, b: 0 };
    }

    this.#colors = colors;
    this.#transparent = transparent;

    // §6.5: warn when a user theme badly violates contrast. This is a warning, not
    // a rejection — it is their terminal.
    const background = colors["bg.base"];
    for (const token of ["fg.primary", "fg.muted"] as const) {
      const ratio = contrastRatio(colors[token], background);
      if (ratio < 3) {
        this.issues.push({
          token,
          message: `contrast against bg.base is ${ratio.toFixed(2)}:1, below the 3:1 minimum for readable text`,
        });
      }
    }
  }

  color(token: ThemeToken): Rgb {
    return this.#colors[token];
  }

  /** Whether this token paints nothing. Only ever true for a `bg.*` token. */
  isTransparent(token: ThemeToken): boolean {
    return this.#transparent.has(token);
  }

  hex(token: ThemeToken): string {
    const { r, g, b } = this.#colors[token];
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  }

  /** SGR parameters for a foreground colour at this depth. */
  fgCode(token: ThemeToken): string | undefined {
    const color = this.#colors[token];
    switch (this.depth) {
      case "truecolor":
        return `38;2;${color.r};${color.g};${color.b}`;
      case "256":
        return `38;5;${toXterm256(color)}`;
      case "16":
        return String(toAnsi16(color));
      case "none":
        return undefined;
    }
  }

  /** SGR parameters for a background colour at this depth. */
  bgCode(token: ThemeToken): string | undefined {
    // A transparent token emits nothing, so whatever the terminal already has —
    // the user's own background — shows through.
    if (this.#transparent.has(token)) return undefined;
    const color = this.#colors[token];
    switch (this.depth) {
      case "truecolor":
        return `48;2;${color.r};${color.g};${color.b}`;
      case "256":
        return `48;5;${toXterm256(color)}`;
      case "16":
        // 16-colour backgrounds are 40–47 / 100–107.
        return String(toAnsi16(color) + 10);
      case "none":
        return undefined;
    }
  }
}

export function defaultTheme(depth: ColorDepth = "truecolor"): Theme {
  return new Theme({ depth });
}

/**
 * §6.6 icon mapping, with the ASCII fallback §6.6 requires when Unicode or emoji
 * width is unreliable.
 */
export type IconName =
  | "user"
  | "final"
  | "success"
  | "active"
  | "working"
  | "task"
  | "tool"
  | "warning"
  | "error"
  | "git"
  | "artifact"
  /** Assistant reasoning in progress (§6.8). */
  | "thinking"
  | "reasoning"
  /** A subagent node heading its own tool tree (§6.10). */
  | "subagent"
  /** The model behind a subagent, shown beside its name. */
  | "model"
  /** Elapsed-time marker on a task or tool line. */
  | "clock"
  | "read"
  | "write"
  | "move"
  | "delete"
  | "run"
  | "search"
  | "ask"
  | "added"
  | "removed"
  /** Result arrow, e.g. `python demo.py -> exit 0`. */
  | "arrow";

const UNICODE_ICONS: Readonly<Record<IconName, string>> = {
  user: "❯",
  final: "✦",
  success: "✓",
  active: "●",
  working: "⋮",
  task: "⧖",
  tool: "◆",
  warning: "!",
  error: "×",
  git: "⎇",
  artifact: "▣",
  thinking: "◈",
  reasoning: "⬡",
  subagent: "✴",
  model: "◇",
  clock: "◷",
  read: "▤",
  write: "▥",
  // Same geometric block as read and write, so the file operations read as a
  // family and every one of them is one column wide.
  move: "▧",
  delete: "▨",
  run: "▶",
  search: "◎",
  ask: "?",
  added: "+",
  removed: "-",
  arrow: "→",
};

const ASCII_ICONS: Readonly<Record<IconName, string>> = {
  user: ">",
  final: "*",
  success: "+",
  active: "*",
  working: ":",
  task: "~",
  tool: "#",
  warning: "!",
  error: "x",
  git: "@",
  artifact: "[]",
  thinking: "%",
  reasoning: "#",
  subagent: "*",
  model: "<>",
  clock: "t",
  read: "r",
  write: "w",
  move: "m",
  delete: "d",
  run: ">",
  search: "/",
  ask: "?",
  added: "+",
  removed: "-",
  arrow: "->",
};

/**
 * Emoji variants, used only where §6.6's width guarantee holds.
 *
 * §6.6 warns that emoji width is unpredictable outside a few terminals, and a
 * mis-measured glyph shifts every column after it. So these are opt-in behind
 * `stableEmojiWidth` and the geometric glyphs above remain the default — the
 * layout must be correct everywhere before it is decorative anywhere.
 */
const EMOJI_ICONS: Readonly<Partial<Record<IconName, string>>> = {
  thinking: "\u{1F9E0}", // brain
  reasoning: "\u{1F9A0}", // microbe
  read: "\u{1F4D6}", // open book
  write: "\u{1F4DD}", // memo
  run: "\u{1F9EA}", // test tube
  search: "\u{1F50D}", // magnifying glass
  model: "\u{1F916}", // robot
  artifact: "\u{1F4E6}", // package
};

export interface IconCapabilities {
  readonly unicode: boolean;
  /** §6.6: emoji are only used where their width is known to be two columns. */
  readonly stableEmojiWidth?: boolean;
}

export function icon(name: IconName, capabilities: IconCapabilities): string {
  if (!capabilities.unicode) return ASCII_ICONS[name];
  if (capabilities.stableEmojiWidth === true) {
    const emoji = EMOJI_ICONS[name];
    if (emoji !== undefined) return emoji;
  }
  return UNICODE_ICONS[name];
}

/**
 * The verb shown for each native tool (§12.2), keyed by tool id.
 *
 * An explicit table rather than a prefix heuristic, because the heuristic got two
 * of them wrong in a way that mattered: `fs.glob` read as `Write` and `fs.delete`
 * read as `Write`. A reader scanning a turn for what happened to their workspace
 * cannot afford a label that says a search wrote something, or that a deletion was
 * an edit.
 *
 * This deliberately does not import the catalog from `@cbc/tool-registry`. The
 * reducer carries only a tool id (§20.8), and the presentation layer stays free of
 * a dependency on the registry — the drift guard lives in `apps/cbc`, which
 * already sees both.
 */
const TOOL_ACTIONS: Readonly<Record<string, string>> = {
  "fs.read": "Read",
  "fs.read_many": "Read",
  "fs.list": "List",
  "fs.glob": "Find",
  "fs.search": "Search",
  "fs.apply_patch": "Patch",
  "fs.edit.preview": "Preview",
  "fs.edit": "Edit",
  "fs.write": "Write",
  "fs.move": "Move",
  "fs.delete": "Delete",
  "process.run": "Run",
  "process.start": "Start",
  "process.input": "Input",
  "process.stop": "Stop",
  "shell.run": "Shell",
  "artifact.read": "Read",
  "git.status": "Git",
  "git.diff": "Git",
  "git.log": "Git",
  "git.show": "Git",
  "git.checkpoint": "Git",
  "worktree.list": "Git",
  "worktree.inspect": "Git",
  "worktree.create": "Git",
  "worktree.remove": "Git",
  "merge.preview": "Preview",
  "merge.apply": "Merge",
  "merge.resolve": "Merge",
  "user.ask": "Ask",
  "user.ask_batch": "Ask",
  "task.search": "Task",
  "task.spawn": "Task",
  "task.status": "Task",
  "task.await": "Await",
  "task.message": "Message",
  "task.cancel": "Task",
  "skill.search": "Skill",
  "skill.load": "Skill",
  "mcp.search": "MCP",
  "mcp.call": "MCP",
  "mcp.read_resource": "MCP",
  "lsp.diagnostics": "Read",
  "lsp.symbols": "Find",
  "lsp.workspace_symbols": "Search",
  "lsp.definition": "Find",
  "lsp.declaration": "Find",
  "lsp.type_definition": "Find",
  "lsp.implementation": "Find",
  "lsp.references": "Find",
  "lsp.hover": "Read",
  "lsp.signature_help": "Read",
  "lsp.document_highlights": "Find",
  "lsp.call_hierarchy": "Find",
  "lsp.code_actions": "Read",
  "lsp.code_action_preview": "Preview",
  "lsp.format_preview": "Preview",
  "lsp.range_format_preview": "Preview",
  "lsp.rename_preview": "Preview",
  "memory.search": "Search",
  "memory.remember": "Remember",
  "todo.write": "TODO",
  "plugin.invoke": "Plugin",
  "tool.discover": "Discover",
  "repo.investigate": "Search",
  "verification.run_many": "Run",
};

/**
 * A tool's action label, e.g. `Read` for `fs.read`.
 *
 * AC-45's rule applies here too: the label is a *word*, so a tree of tool calls
 * stays readable with no colour and no icons at all.
 *
 * The prefix fallback exists for ids that cannot be tabulated ahead of time — an
 * MCP server registers `mcp.<server>.<tool>` at runtime (§16.4) — and is
 * deliberately conservative: an unrecognized `fs.*` id is `File`, not `Write`,
 * because guessing "this wrote something" about an unknown tool is the mistake
 * this table was introduced to fix.
 */
export function toolActionLabel(toolId: string): string {
  const id = toolId.toLowerCase();
  const known = TOOL_ACTIONS[id];
  if (known !== undefined) return known;

  if (id.startsWith("mcp.")) return "MCP";
  if (id.startsWith("task.")) return "Task";
  if (id.startsWith("skill.")) return "Skill";
  if (id.startsWith("git.")) return "Git";
  if (id.startsWith("process.") || id.startsWith("shell.")) return "Run";
  if (id.startsWith("fs.")) return "File";
  return "Tool";
}

/**
 * Whether this tool id has a verb of its own rather than falling back to a guess.
 *
 * Exists for the drift guard in `apps/cbc`: a tool added to the §12.2 catalog with
 * no entry here would silently render under a coarse fallback, which is how
 * `fs.glob` came to be labelled `Write` in the first place.
 */
export function hasExplicitToolAction(toolId: string): boolean {
  return TOOL_ACTIONS[toolId.toLowerCase()] !== undefined;
}

/** The icon that goes with a `toolActionLabel`. */
export function toolActionIcon(toolId: string): IconName {
  switch (toolActionLabel(toolId)) {
    case "Preview":
    case "Read":
    case "List":
      return "read";
    case "Find":
    case "Search":
    case "Discover":
      return "search";
    case "Write":
    case "Edit":
    case "Patch":
    case "File":
      return "write";
    case "Move":
      return "move";
    case "Delete":
      return "delete";
    case "Run":
    case "Start":
    case "Shell":
      return "run";
    case "Stop":
    case "Input":
      return "tool";
    case "Git":
      return "git";
    case "Task":
      return "subagent";
    case "Plugin":
      return "tool";
    case "TODO":
      return "task";
    case "Skill":
    case "Remember":
      return "artifact";
    case "Ask":
      return "ask";
    default:
      return "tool";
  }
}

/** §6.6 tree connectors, with an ASCII fallback. */
export interface TreeGlyphs {
  readonly vertical: string;
  readonly branch: string;
  readonly last: string;
  readonly space: string;
  /**
   * Three-cell connectors for the subagent tool tree (§6.10).
   *
   * A deeper indent than the two-cell `branch` on purpose: the tool tree nests
   * under a card that already carries a `│` gutter, and at two cells the two
   * levels read as one.
   */
  readonly branchLong: string;
  readonly lastLong: string;
  /** Continuation gutter aligned under `branchLong`. */
  readonly gutter: string;
  /** Blank continuation aligned under `lastLong`. */
  readonly gutterEnd: string;
  /** Horizontal rule fill, for a panel divider. */
  readonly horizontal: string;
}

export function treeGlyphs(capabilities: { unicode: boolean }): TreeGlyphs {
  return capabilities.unicode
    ? {
        vertical: "│",
        branch: "├─",
        last: "└─",
        space: " ",
        branchLong: "├──",
        lastLong: "└──",
        gutter: "│  ",
        gutterEnd: "   ",
        horizontal: "─",
      }
    : {
        vertical: "|",
        branch: "|-",
        last: "`-",
        space: " ",
        branchLong: "|--",
        lastLong: "`--",
        gutter: "|  ",
        gutterEnd: "   ",
        horizontal: "-",
      };
}
