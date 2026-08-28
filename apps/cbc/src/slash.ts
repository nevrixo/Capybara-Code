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
 * automatic line mode.
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
  | { readonly kind: "status" }
  | { readonly kind: "memory"; readonly action?: "inspect" | "forget" | "resolve"; readonly argument?: string }
  | { readonly kind: "compact" }
  | { readonly kind: "resume"; readonly id?: string }
  | { readonly kind: "new_session" }
  | { readonly kind: "quit" };

/** Overlay-only commands, so the table stays the single source of truth. */
const OVERLAY_FOR: Readonly<Record<string, OverlayKind>> = {
  "/skills": "skills",
  "/mcp": "mcp",
  "/context": "context",
  "/graph": "graph",
  "/worktree": "worktree",
  "/plugins": "plugins",
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
      const preset = rest.filter((t) => t !== "--save")[0];
      // YOLO is an explicit global preference: selecting it applies and saves in
      // one step. Other presets remain session-scoped unless `--save` is present.
      const save = preset === "yolo" || rest.includes("--save");
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
    case "/status":
      return { kind: "status" };
    case "/memory": {
      const action = rest[0] === "inspect" || rest[0] === "forget" || rest[0] === "resolve"
        ? rest[0]
        : undefined;
      const memoryArg = rest.slice(action === undefined ? 0 : 1).join(" ").trim();
      return {
        kind: "memory",
        ...(action !== undefined ? { action } : {}),
        ...(memoryArg.length > 0 ? { argument: memoryArg } : {}),
      };
    }
    case "/compact":
      return { kind: "compact" };
    case "/new":
      return { kind: "new_session" };
    case "/resume":
      return arg === undefined
        ? { kind: "overlay", overlay: "sessions" }
        : { kind: "resume", id: arg };
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
  /** Current stage-1 Skill catalog for /skills completion. */
  readonly skills?: readonly CompletionCandidate[];
} = {}): readonly CompletionCandidate[] | undefined {
  switch (input.command) {
    case "/skills": {
      const subcommands: readonly CompletionCandidate[] = [
        { value: "list", detail: "catalog" },
        { value: "show", detail: "details" },
        { value: "reload", detail: "rescan" },
        { value: "doctor", detail: "diagnostics" },
      ];
      if (input.index === 0) return [...subcommands, ...(options.skills ?? [])];
      if (input.index === 1 && input.preceding?.[0]?.toLowerCase() === "show") {
        return options.skills ?? [];
      }
      return undefined;
    }
    case "/model":
      if (input.index > 0) return undefined;
      return MODEL_REGISTRY.map((model) => ({
        value: model.id,
      }));
    case "/effort":
      if (input.index > 0) return undefined;
      return REASONING_EFFORTS.map((value) => ({ value, detail: "effort" }));
    case "/permissions":
      if (input.index > 0) return undefined;
      return PERMISSION_PRESETS.map((value) =>
        value === "auto" ? { value, detail: "recommended" } : value === "yolo" ? { value, detail: "dangerous" } : { value },
      );
    case "/mode":
      if (input.index > 0) return undefined;
      return ["build", "plan"].map((value) => ({ value, detail: value === "plan" ? "read-only" : "implementation" }));
    case "/resume":
      if (input.index > 0) return undefined;
      // Unlike model/effort values, sessions are not part of the static command
      // table. Keep the resolver pure and let the interactive host provide the
      // current workspace's entries.
      return options.sessions ?? [];
    default:
      // `undefined` means "no host values"; the popup falls back to the spec's own
      // list, and shows only the signature when there is none.
      return undefined;
  }
}
