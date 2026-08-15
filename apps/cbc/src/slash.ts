/**
 * Slash command router — PRD §8.10, §6.17.
 *
 * §8.10 is explicit that a slash command is handled by a local router and never
 * sent to the model. That is a correctness requirement, not an optimization: `/compact`
 * changes host state, and a model that saw it as prose could respond to it instead of
 * the host acting on it.
 *
 * The router is pure — it maps input to an intent. Executing the intent belongs to
 * whichever front end is running, so the same table serves the full TUI and
 * `--plain`.
 */

import { configEnumValues } from "@cbc/config-schema";
import {
  MODEL_REGISTRY,
} from "@cbc/provider-openai";
import {
  SLASH_COMMANDS,
  searchSlashCommands,
  type CommandArgument,
  type CompletionCandidate,
  type OverlayKind,
} from "@cbc/tui-components";

/** Actions on the durable Plan Contract. */
export type PlanSlashAction = "enter" | "show" | "refine" | "approve" | "execute";
export type PlanContextStrategy = "keep" | "compact";

export type SlashIntent =
  | { readonly kind: "not_slash" }
  | { readonly kind: "unknown"; readonly name: string; readonly suggestions: string[] }
  | { readonly kind: "overlay"; readonly overlay: OverlayKind; readonly argument?: string }
  | { readonly kind: "help"; readonly topic?: string }
  | { readonly kind: "set_model"; readonly model?: string }
  | { readonly kind: "set_reasoning"; readonly value?: string }
  | { readonly kind: "setting"; readonly setting?: string; readonly value?: string }
  | { readonly kind: "set_permission"; readonly preset?: string; readonly save?: boolean }
  | { readonly kind: "set_mode"; readonly mode?: "build" | "plan"; readonly save?: boolean; readonly stopActive?: boolean }
  /** `/plan` with a subcommand operates on the contract rather than only toggling mode. */
  | {
      readonly kind: "plan";
      readonly action: PlanSlashAction;
      /** Free-form refinement request for `/plan refine ...`. */
      readonly instruction?: string;
      /** Alias retained for hosts that call this field `text`. */
      readonly text?: string;
      readonly contextStrategy?: PlanContextStrategy;
    }
  | { readonly kind: "todo"; readonly action?: "show" | "clear" | "approve" | "hide" }
  | { readonly kind: "status" }
  | { readonly kind: "approvals"; readonly argument?: string }
  | { readonly kind: "compact" }
  | { readonly kind: "resume"; readonly id?: string }
  | { readonly kind: "export"; readonly format: "markdown" | "jsonl" | "bundle" }
  | { readonly kind: "new_session" }
  | { readonly kind: "quit" };

/** Overlay-only commands, so the table stays the single source of truth. */
const OVERLAY_FOR: Readonly<Record<string, OverlayKind>> = {
  "/skills": "skills",
  "/mcp": "mcp",
  "/context": "context",
};

/**
 * Parse a composer line.
 *
 * A command is recognized when the first non-space character is `/`, matching
 * `completionKindAt` in `@cbc/tui-components`. Keeping the two in agreement matters:
 * anything the composer offered completion for has to actually route as a command,
 * or the user gets a popup for text that ends up sent to the model.
 */
export function parseSlash(raw: string): SlashIntent {
  const text = raw.trimStart();
  if (!text.startsWith("/")) return { kind: "not_slash" };

  const [head, ...rest] = text.trim().split(/\s+/);
  const name = (head ?? "").toLowerCase();
  const argument = rest.join(" ").trim();
  const arg = argument.length > 0 ? argument : undefined;

  const overlay = OVERLAY_FOR[name];
  if (overlay !== undefined) {
    return { kind: "overlay", overlay, ...(arg !== undefined ? { argument: arg } : {}) };
  }

  switch (name) {
    case "/help":
      return { kind: "help", ...(arg !== undefined ? { topic: arg } : {}) };
    case "/model":
      // With no argument this keeps a list intent for line-oriented clients; with one it applies directly, which
      // is what makes `/model gpt-5.6` usable in a script-like flow.
      return arg === undefined
        ? { kind: "overlay", overlay: "model_picker" }
        : { kind: "set_model", model: arg };
    case "/effort":
      return arg === undefined
        ? { kind: "overlay", overlay: "reasoning_picker" }
        : { kind: "set_reasoning", value: arg };
    case "/setting": {
      const setting = rest[0]?.toLowerCase();
      const value = rest.length > 1 ? rest.slice(1).join(" ").toLowerCase() : undefined;
      return {
        kind: "setting",
        ...(setting !== undefined ? { setting } : {}),
        ...(value !== undefined ? { value } : {}),
      };
    }
  case "/permissions": {
      const save = rest.includes("--save");
      const preset = rest.filter((t) => t !== "--save")[0];
      return { kind: "set_permission", ...(preset !== undefined ? { preset } : {}), ...(save ? { save: true } : {}) };
    }
    case "/mode": {
      const save = rest.includes("--save");
      const stopActive = rest.includes("--stop-active");
      const value = rest.find((token) => token !== "--save" && token !== "--stop-active");
      return {
        kind: "set_mode",
        ...(value === "build" || value === "plan" ? { mode: value } : {}),
        ...(save ? { save: true } : {}),
        ...(stopActive ? { stopActive: true } : {}),
      };
    }
    case "/build":
      return { kind: "set_mode", mode: "build" };
    case "/plan": {
      // Keep the bare alias compatible with existing callers. Subcommands are
      // deliberately separate intents: treating `/plan approve` as a mode toggle
      // would silently discard the approval strategy and make the execution gate
      // unenforceable.
      const actionToken = rest[0]?.toLowerCase();
      const action: PlanSlashAction | undefined =
        actionToken === "enter" || actionToken === "show" || actionToken === "refine" ||
        actionToken === "approve" || actionToken === "execute"
          ? actionToken
          : undefined;
      if (action === undefined) return { kind: "set_mode", mode: "plan" };

      const compact = rest.some((token) => token.toLowerCase() === "--compact");
      const keep = rest.some((token) => token.toLowerCase() === "--keep");
      const contextStrategy = compact ? "compact" : keep ? "keep" : undefined;
      const instruction = action === "refine"
        ? rest.slice(1).filter((token) => !token.startsWith("--")).join(" ").trim()
        : undefined;
      return {
        kind: "plan",
        action,
        ...(instruction !== undefined && instruction.length > 0
          ? { instruction, text: instruction }
          : {}),
        ...(contextStrategy !== undefined ? { contextStrategy } : {}),
      };
    }
    case "/todo": {
      const action = rest.find((token) => !token.startsWith("--"));
      return {
        kind: "todo",
        ...(action === "show" || action === "clear" || action === "approve" || action === "hide" ? { action } : {}),
      };
    }
    case "/status":
      return { kind: "status" };
    case "/approvals":
      return { kind: "approvals", ...(arg !== undefined ? { argument: arg } : {}) };
    case "/compact":
      return { kind: "compact" };
    case "/new":
      return { kind: "new_session" };
    case "/resume":
      return arg === undefined
        ? { kind: "overlay", overlay: "sessions" }
        : { kind: "resume", id: arg };
    case "/export": {
      const format = arg === "jsonl" || arg === "bundle" ? arg : "markdown";
      return { kind: "export", format };
    }
    case "/quit":
    case "/exit":
      return { kind: "quit" };
    default:
      return {
        kind: "unknown",
        name,
        suggestions: searchSlashCommands(name).map((command) => command.name),
      };
  }
}

/** Completion candidates for the composer's command popup (§6.14). */
export function slashCompletions(prefix: string): Array<{ value: string; detail: string }> {
  return searchSlashCommands(prefix).map((command) => ({
    value: command.name,
    detail: command.description,
  }));
}

export { SLASH_COMMANDS };

/**
 * Values `/effort` accepts, read from the config schema rather than restated.
 *
 * §21.4 already declares the legal efforts and modes, and the completion popup now
 * offers whatever is listed here. A second hand-written copy would eventually offer
 * a value that `capy config set` rejects, which is a worse failure than a missing
 * completion: the user is told the value is valid and then told it is not.
 */
export const REASONING_EFFORTS: readonly string[] =
  configEnumValues("model.reasoningEffort") ?? [];

export const REASONING_MODES: readonly string[] = configEnumValues("model.reasoningMode") ?? [];

export const REASONING_VALUES: readonly string[] = [...REASONING_EFFORTS, ...REASONING_MODES];

export const PERMISSION_PRESETS: readonly string[] = configEnumValues("permissions.preset") ?? ["read", "edit", "auto", "yolo"];

/** Values accepted by explicit `/setting token-saving <level>` commands. */
export const TOKEN_SAVING_VALUES: readonly string[] =
  configEnumValues("agent.tokenSaving") ?? ["off", "light", "balanced", "strong"];

/** §8.10 `/export` formats. Not a config key, so the list lives here. */
export const EXPORT_FORMATS: readonly string[] = ["markdown", "jsonl", "bundle"];

export function isReasoningValue(value: string): boolean {
  return REASONING_VALUES.includes(value);
}


/**
 * Argument values for the §6.14 completion popup.
 *
 * The popup asks, this answers — which is why the model list can come from the
 * registry and the session list from disk without `@cbc/tui-components` knowing
 * either exists.
 */
export function slashArgumentValues(input: {
  readonly command: string;
  readonly index: number;
  readonly argument: CommandArgument | undefined;
  readonly query: string;
  /** Argument tokens already typed before the active one, in order. */
  readonly preceding?: readonly string[];
}, options: {
  /** Session ids are workspace state, so the interactive host supplies them. */
  readonly sessions?: readonly CompletionCandidate[];
  /** The active model lets effort completion hide unsupported values. */
  readonly model?: string;
} = {}): readonly CompletionCandidate[] | undefined {
  // Plan has a small, static action vocabulary followed by an optional
  // context strategy. Other commands currently expose only one argument.
  if (input.command === "/plan") {
    if (input.index === 0) {
      return [
        { value: "enter", detail: "enter read-only Plan mode" },
        { value: "show", detail: "review the Plan Contract" },
        { value: "refine", detail: "edit the plan with a request" },
        { value: "approve", detail: "approve the contract" },
        { value: "execute", detail: "approve and run the contract" },
      ];
    }
    if (input.index === 1 && input.argument?.name === "strategy") {
      return [
        { value: "keep", detail: "preserve context" },
        { value: "compact", detail: "compact provider context" },
      ];
    }
    return undefined;
  }
  if (input.index > 0) return undefined;

  switch (input.command) {
    case "/model":
      return MODEL_REGISTRY.map((model) => ({
        value: model.id,
      }));
    case "/effort":
      return REASONING_EFFORTS.map((value) => ({ value, detail: "effort" }));
    case "/permissions":
      return PERMISSION_PRESETS.map((value) =>
        value === "auto" ? { value, detail: "recommended" } : value === "yolo" ? { value, detail: "dangerous" } : { value },
      );
    case "/mode":
      return ["build", "plan"].map((value) => ({ value, detail: value === "plan" ? "read-only" : "implementation" }));
    case "/todo":
      return ["show", "clear", "approve", "hide"].map((value) => ({ value }));
    case "/resume":
      // Unlike model/effort values, sessions are not part of the static command
      // table. Keep the resolver pure and let the interactive host provide the
      // current workspace's entries.
      return options.sessions ?? [];
    case "/export":
      return EXPORT_FORMATS.map((value) => ({ value }));
    default:
      // `undefined` means "no host values"; the popup falls back to the spec's own
      // list, and shows only the signature when there is none.
      return undefined;
  }
}
