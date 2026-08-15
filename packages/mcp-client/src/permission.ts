/**
 * MCP permission model — PRD §17.8, §17.5, AC-32, PERM-001.
 *
 * §17.8's risk sources, highest authority first:
 *
 * 1. user override
 * 2. signed or built-in metadata
 * 3. tool annotations
 * 4. heuristic classifier
 * 5. unknown → ask
 *
 * The order matters because it puts the server *last* among the things that get to
 * describe its own risk. §17.8's closing line makes that explicit: a server can
 * claim read-only and still be promoted.
 */

import type { ProposedAction } from "@cbc/permissions";

import type { McpCapabilityDescriptor, McpCapabilityRisk } from "./catalog.ts";
import { classifyMcpCapability } from "./catalog.ts";

export type RiskSource =
  | "user-override"
  | "builtin-metadata"
  | "annotation"
  | "classifier"
  | "unknown-default";

export interface ResolvedMcpRisk {
  readonly risk: McpCapabilityRisk;
  readonly source: RiskSource;
  readonly reasons: string[];
  /** Whether CBC raised the risk above what the server claimed (§17.8). */
  readonly promotedOverServerClaim: boolean;
}

export interface RiskResolutionInput {
  readonly server: string;
  readonly name: string;
  readonly annotations?: McpCapabilityDescriptor["annotations"];
  /** §17.8 step 1: `server/tool` or bare `tool` key from user config. */
  readonly userOverrides?: Readonly<Record<string, McpCapabilityRisk>>;
  /** §17.8 step 2: metadata shipped with CBC or signed by a trusted publisher. */
  readonly builtinMetadata?: Readonly<Record<string, McpCapabilityRisk>>;
}

/** Resolve a capability's risk through the §17.8 chain. */
export function resolveMcpRisk(input: RiskResolutionInput): ResolvedMcpRisk {
  const qualified = `${input.server}/${input.name}`;
  const classified = classifyMcpCapability({
    name: input.name,
    ...(input.annotations !== undefined ? { annotations: input.annotations } : {}),
  });

  const override = input.userOverrides?.[qualified] ?? input.userOverrides?.[input.name];
  if (override !== undefined) {
    return {
      risk: override,
      source: "user-override",
      reasons: [`the user set ${qualified} to '${override}'`],
      promotedOverServerClaim: false,
    };
  }

  const builtin = input.builtinMetadata?.[qualified] ?? input.builtinMetadata?.[input.name];
  if (builtin !== undefined) {
    return {
      risk: builtin,
      source: "builtin-metadata",
      reasons: [`bundled metadata classifies ${qualified} as '${builtin}'`],
      promotedOverServerClaim: false,
    };
  }

  const claimsReadOnly = input.annotations?.readOnlyHint === true;
  const promoted = claimsReadOnly && classified.risk !== "read";

  if (classified.risk === "unknown") {
    // §17.8 step 5.
    return {
      risk: "unknown",
      source: "unknown-default",
      reasons: [...classified.reasons, "an unclassifiable capability requires approval"],
      promotedOverServerClaim: false,
    };
  }

  const usedAnnotation =
    input.annotations !== undefined &&
    (input.annotations.destructiveHint === true || claimsReadOnly) &&
    !promoted;

  return {
    risk: classified.risk,
    source: usedAnnotation ? "annotation" : "classifier",
    reasons: classified.reasons,
    promotedOverServerClaim: promoted,
  };
}

/** §17.8's default decision table. */
export type McpDefaultDecision = "allow" | "ask";

export interface McpPolicyContext {
  /** §21.4 `permissions.network`. */
  readonly network: "deny" | "ask" | "allow";
  /** §21.4 `permissions.externalSideEffect`. */
  readonly externalSideEffect: "deny" | "ask";
  /** §13.6: an untrusted workspace does not launch project servers at all. */
  readonly workspaceTrusted: boolean;
  /** Whether this server came from project config (§17.5). */
  readonly serverFromProjectConfig: boolean;
}

export interface McpDecision {
  readonly decision: McpDefaultDecision | "deny";
  readonly reason: string;
  readonly risk: McpCapabilityRisk;
}

/**
 * Decide what a capability needs before it runs.
 *
 * §17.8's table in code: a docs read is allowed, a listing follows the network
 * policy, anything that creates or comments asks, and anything destructive always
 * asks. §13.2 forbids a persistent grant for R6, so a destructive MCP call can
 * never be pre-approved in bulk — the decision returned here is per operation.
 */
export function decideMcpCapability(
  risk: McpCapabilityRisk,
  context: McpPolicyContext,
): McpDecision {
  // PERM-001: a project-supplied server is inert in an untrusted workspace.
  if (context.serverFromProjectConfig && !context.workspaceTrusted) {
    return {
      decision: "deny",
      reason:
        "this MCP server is configured by the project, which is not trusted; trust the workspace to enable it (§13.6, PERM-001)",
      risk,
    };
  }

  if (context.network === "deny") {
    return {
      decision: "deny",
      reason: "network access is denied by configuration, and every MCP call is a network call",
      risk,
    };
  }

  switch (risk) {
    case "read":
      return context.network === "allow"
        ? { decision: "allow", reason: "a read-only MCP call under an allow-network policy", risk }
        : {
            decision: "ask",
            reason: "a read-only MCP call, but the network policy is 'ask'",
            risk,
          };

    case "write":
      if (context.externalSideEffect === "deny") {
        return {
          decision: "deny",
          reason: "external side effects are denied by configuration",
          risk,
        };
      }
      return {
        decision: "ask",
        reason: "this call changes state in an external system (§13.2 R6)",
        risk,
      };

    case "destructive":
      if (context.externalSideEffect === "deny") {
        return {
          decision: "deny",
          reason: "external side effects are denied by configuration",
          risk,
        };
      }
      // §13.2: no session-wide or project-wide allow is possible for R6.
      return {
        decision: "ask",
        reason:
          "this call is destructive in an external system and is approved one operation at a time (§13.2)",
        risk,
      };

    case "unknown":
      return {
        decision: "ask",
        reason: "the capability's side effects could not be determined (§17.8)",
        risk,
      };
  }
}

/**
 * Build the `ProposedAction` the policy engine evaluates.
 *
 * The server's own read-only claim is passed through as `annotatedReadOnly` so
 * `assessRisk` can note the disagreement, and `sideEffectHint` carries the
 * *resolved* risk rather than the server's — the policy engine should see CBC's
 * conclusion, not the server's marketing.
 */
export function mcpProposedAction(input: {
  callId: string;
  server: string;
  tool: string;
  arguments: Record<string, unknown>;
  resolved: ResolvedMcpRisk;
  annotatedReadOnly?: boolean;
}): ProposedAction {
  const hint = hintFor(input.resolved.risk);
  return {
    callId: input.callId,
    toolId: `mcp.${input.server}.${input.tool}`,
    arguments: input.arguments,
    display: `${input.server}/${input.tool} ${summarizeArguments(input.arguments)}`,
    mcp: {
      server: input.server,
      tool: input.tool,
      ...(input.annotatedReadOnly !== undefined
        ? { annotatedReadOnly: input.annotatedReadOnly }
        : {}),
      sideEffectHint: hint,
    },
  };
}

function hintFor(risk: McpCapabilityRisk): "read" | "write" | "destructive" | "unknown" {
  return risk;
}

function summarizeArguments(args: Record<string, unknown>): string {
  const text = JSON.stringify(args);
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

/**
 * Merge server configuration across §17.5's layers.
 *
 * The rule that shapes this: "Project server cannot override user server
 * credential source or weaken TLS/approval policy." A project layer may add a
 * server or adjust benign fields, but every attempt to touch auth, TLS, or trust is
 * dropped and reported so the user can see it was tried.
 */
export interface ServerConfigLayer {
  readonly source: "user" | "project" | "session";
  readonly servers: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/** Fields a project layer may never set on a server the user already defined. */
const PROJECT_PROTECTED_FIELDS = new Set([
  "auth",
  "token",
  "credential",
  "credentials",
  "headers",
  "allowInsecureLoopback",
  "insecure",
  "rejectUnauthorized",
  "tls",
  "caFile",
  "approval",
  "riskOverrides",
]);

export interface MergedServerConfig {
  readonly servers: Record<string, Record<string, unknown>>;
  readonly rejected: Array<{ server: string; field: string; reason: string }>;
}

export function mergeServerConfig(layers: readonly ServerConfigLayer[]): MergedServerConfig {
  const servers: Record<string, Record<string, unknown>> = {};
  const definedBy: Record<string, ServerConfigLayer["source"]> = {};
  const rejected: Array<{ server: string; field: string; reason: string }> = [];

  const order: Array<ServerConfigLayer["source"]> = ["user", "project", "session"];
  const sorted = [...layers].sort(
    (a, b) => order.indexOf(a.source) - order.indexOf(b.source),
  );

  for (const layer of sorted) {
    for (const [name, config] of Object.entries(layer.servers)) {
      const existing = servers[name];

      if (existing === undefined) {
        servers[name] = { ...config };
        definedBy[name] = layer.source;
        continue;
      }

      for (const [field, value] of Object.entries(config)) {
        if (
          layer.source === "project" &&
          definedBy[name] === "user" &&
          PROJECT_PROTECTED_FIELDS.has(field)
        ) {
          rejected.push({
            server: name,
            field,
            reason:
              "a project config cannot override the credential source or weaken TLS and approval policy for a user-defined server (§17.5)",
          });
          continue;
        }
        existing[field] = value;
      }
    }
  }

  return { servers, rejected };
}
