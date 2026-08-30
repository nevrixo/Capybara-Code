/**
 * `@cbc/tool-registry` — the native tool catalog, argument validation, discovery
 * ranking, and the tool scheduler (PRD §12).
 */

export * from "./catalog.ts";
export * from "./action-groups.ts";
export * from "./validate.ts";
export * from "./discovery.ts";
export * from "./scheduler.ts";
export * from "./graph.ts";
export * from "./recovery.ts";

import { isPlanSafeTool, nativeToolsForFeatures, withExecutionMetadata, type ToolDefinition } from "./catalog.ts";
import { discover, type DiscoveryOptions, type ToolDiscoveryResult } from "./discovery.ts";
import { parseAndValidate, type ValidationResult } from "./validate.ts";

/** Keep Plan Contracts out of the model-facing Build-mode TODO schema. */
function buildModeToolView(tool: ToolDefinition): ToolDefinition {
  if (tool.id !== "todo.write") return tool;
  const properties = tool.parameters.properties;
  if (properties === null || typeof properties !== "object" || Array.isArray(properties)) return tool;
  const record = properties as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, "document")) return tool;
  const { document: _document, ...buildProperties } = record;
  return {
    ...tool,
    description: `${tool.description} In Build mode, submit ordinary TODO items only; structured Plan Contracts are available only in Plan mode.`,
    parameters: {
      ...tool.parameters,
      properties: buildProperties,
    },
  };
}

/**
 * The live catalog: native tools plus anything contributed by Skills and MCP at
 * runtime. §6.9 requires dynamic tools to use the same discovery UI, which is why
 * they land in the same registry rather than a parallel one.
 */
export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition>();
  readonly #active = new Set<string>();
  #interactionMode: "build" | "plan" = "build";

  constructor(initial: readonly ToolDefinition[] = nativeToolsForFeatures()) {
    for (const tool of initial) this.#tools.set(tool.id, withExecutionMetadata(tool));
    for (const tool of initial) {
      if (tool.alwaysActive) this.#active.add(tool.id);
    }
  }

  get size(): number {
    return this.#tools.size;
  }

  all(): ToolDefinition[] {
    return [...this.#tools.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): ToolDefinition | undefined {
    return this.#tools.get(id);
  }

  has(id: string): boolean {
    return this.#tools.has(id);
  }

  /** Register a Skill- or MCP-contributed tool. */
  register(tool: ToolDefinition): void {
    this.#tools.set(tool.id, withExecutionMetadata(tool));
    if (tool.alwaysActive) this.#active.add(tool.id);
  }

  unregister(id: string): boolean {
    this.#active.delete(id);
    return this.#tools.delete(id);
  }

  /** Remove every tool from one source, e.g. when an MCP server disconnects. */
  unregisterSource(source: ToolDefinition["source"]): number {
    let removed = 0;
    for (const [id, tool] of this.#tools) {
      if (tool.source === source) {
        this.#tools.delete(id);
        this.#active.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  activeIds(): string[] {
    return [...this.#active].sort();
  }

  /** Schemas offered to the model on the next sampling step. */
  activeTools(): ToolDefinition[] {
    return this.activeToolsFor(this.#interactionMode);
  }

  activeToolsFor(mode: "build" | "plan"): ToolDefinition[] {
    return this.activeIds()
      .map((id) => this.#tools.get(id))
      .filter((tool): tool is ToolDefinition => tool !== undefined)
      .filter((tool) => mode === "build" || isPlanSafeTool(tool))
      .map((tool) => mode === "build" ? buildModeToolView(tool) : tool);
  }

  setInteractionMode(mode: "build" | "plan"): void {
    this.#interactionMode = mode;
  }

  interactionMode(): "build" | "plan" {
    return this.#interactionMode;
  }

  activate(ids: readonly string[]): string[] {
    const added: string[] = [];
    for (const id of ids) {
      if (!this.#tools.has(id) || this.#active.has(id)) continue;
      this.#active.add(id);
      added.push(id);
    }
    return added;
  }

  /** Reset to always-active tools only, e.g. at the start of a subagent turn. */
  resetActivation(): void {
    this.#active.clear();
    for (const tool of this.#tools.values()) {
      if (tool.alwaysActive) this.#active.add(tool.id);
    }
  }

  discover(query: string, options: DiscoveryOptions = {}): ToolDiscoveryResult {
    return this.discoverFor(query, this.#interactionMode, options);
  }

  discoverFor(query: string, mode: "build" | "plan", options: DiscoveryOptions = {}): ToolDiscoveryResult {
    // §21.4's activation limit governs *discovered* schemas. Always-active tools
    // form the baseline catalog and are excluded from the budget, otherwise the
    // baseline would consume the whole allowance (R-08).
    const alwaysActive = new Set(
      this.all()
        .filter((tool) => tool.alwaysActive)
        .map((tool) => tool.id),
    );
    const discoveredActive = (options.alreadyActive ?? this.activeIds()).filter(
      (id) => !alwaysActive.has(id),
    );
    const permitted = options.permitted ?? ((tool: ToolDefinition) => mode === "build" || isPlanSafeTool(tool));
    const result = discover(this.all(), query, {
      ...options,
      permitted,
      alreadyActive: discoveredActive,
    });
    this.activate(result.activated);
    return {
      ...result,
      // The count the UI shows is the true number of active schemas (§6.9).
      activeCount: this.activeIds().length,
    };
  }

  /** Validate a streamed tool call before it can execute (§12.1, AC-10). */
  validateCall(toolId: string, argumentsText: string, mode = this.#interactionMode): ValidationResult {
    const tool = this.#tools.get(toolId);
    if (!tool) {
      return {
        ok: false,
        errors: [{ path: ".", message: `unknown tool '${toolId}'` }],
      };
    }
    if (!this.#active.has(toolId)) {
      return {
        ok: false,
        errors: [
          {
            path: ".",
            message: `tool '${toolId}' is not active; call tool.discover first`,
          },
        ],
      };
    }
    if (mode === "plan" && !isPlanSafeTool(tool)) {
      return {
        ok: false,
        errors: [{ path: ".", message: `tool '${toolId}' is not available in Plan mode` }],
      };
    }
    return parseAndValidate(argumentsText, tool.parameters);
  }
}
