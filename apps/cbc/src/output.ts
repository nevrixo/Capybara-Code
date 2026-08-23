/** Terminal output mode selection and line-oriented rendering. */

import {
  Theme,
  detectCapabilities,
  renderAnsi,
  renderPlain,
  sanitizeText,
  type StyledLine,
  type TerminalCapabilities,
} from "@cbc/tui-components";

import type { Host } from "./host.ts";

export type RenderMode = "opentui" | "plain";

export interface RenderDecision {
  readonly mode: RenderMode;
  readonly capabilities: TerminalCapabilities;
  readonly theme: Theme;
  readonly reason: string;
}

export interface RenderModeInput {
  readonly host: Host;
  readonly rendererAvailable?: boolean;
}

/** Choose fullscreen rendering for a supported TTY and plain output otherwise. */
export function decideRenderMode(input: RenderModeInput): RenderDecision {
  const { host } = input;
  const capabilities = detectCapabilities(host.env, {
    columns: host.io.columns,
    rows: host.io.rows,
    isTty: host.io.isTty,
    platform: host.platform,
  });
  const theme = new Theme({ depth: capabilities.colorDepth });

  if (host.io.isTty !== true) {
    return { mode: "plain", capabilities, theme, reason: "not a terminal" };
  }
  if (input.rendererAvailable === false) {
    return { mode: "plain", capabilities, theme, reason: "native renderer unavailable" };
  }
  return { mode: "opentui", capabilities, theme, reason: "interactive terminal" };
}

export class LineWriter {
  readonly #host: Host;
  readonly #decision: RenderDecision;

  constructor(host: Host, decision: RenderDecision) {
    this.#host = host;
    this.#decision = decision;
  }

  get mode(): RenderMode {
    return this.#decision.mode;
  }

  write(lines: readonly StyledLine[]): void {
    if (lines.length === 0) return;
    const text =
      this.#decision.theme.depth === "none"
        ? renderPlain(lines)
        : renderAnsi(lines, {
            theme: this.#decision.theme,
            capabilities: this.#decision.capabilities,
            columns: this.#decision.capabilities.columns,
          });
    this.#host.io.stdout(text + "\n");
  }

  text(value: string): void {
    this.#host.io.stdout(value.endsWith("\n") ? value : value + "\n");
  }

  trustedText(value: string): void {
    this.text(value);
  }

  untrustedText(value: string): void {
    this.text(sanitizeText(value));
  }

  lines(values: readonly string[]): void {
    if (values.length === 0) return;
    this.text(values.join("\n"));
  }

  diagnostic(value: string): void {
    this.#host.io.stderr(value.endsWith("\n") ? value : value + "\n");
  }
}
