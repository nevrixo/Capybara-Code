/**
 * Hosted multi-agent lane: the read-only Scout/Reviewer request builder (§8.1).
 *
 * §5.6's central invariant is that a hosted scout runs as a *separate* read-only
 * request, not as a widened version of the root turn. Nothing constructed that
 * request, so the lane had no production call site at all and the kernel always
 * demoted it. The separation is enforced here rather than trusted: the builder
 * takes the catalog the gate admitted and refuses to emit a request carrying a
 * tool outside it, so the root's writer tools cannot travel into a scout subtree
 * even if a caller hands them over.
 */

import {
  DEFAULT_HOSTED_SCOUT_POLICY,
  PROGRAM_TOOL_ALLOWLIST,
  acceptHostedScoutReport,
  validateHostedScoutRequest,
  type HostedReportDecision,
  type HostedRole,
  type HostedScoutDecision,
  type HostedScoutPolicy,
  type HostedScoutReport,
  type HostedScoutRequest,
  type HostedScoutUsage,
} from "./native-lanes.ts";
import type {
  ModelEvent,
  ModelRequest,
  ModelToolSchema,
  ReasoningEffort,
  ReasoningMode,
} from "./types.ts";

export {
  DEFAULT_HOSTED_SCOUT_POLICY,
  acceptHostedScoutReport,
  validateHostedScoutRequest,
  type HostedReportDecision,
  type HostedRole,
  type HostedScoutDecision,
  type HostedScoutPolicy,
  type HostedScoutReport,
  type HostedScoutRequest,
  type HostedScoutUsage,
} from "./native-lanes.ts";

/** What a scout is told about its own boundaries, per role. */
const ROLE_BRIEF: Readonly<Record<HostedRole, string>> = {
  HostedScout:
    "You are a read-only scout. Investigate and report findings with evidence references. You cannot edit files, run processes, or request approvals.",
  HostedReviewer:
    "You are a read-only reviewer. Assess the described change against the evidence you can read. You cannot edit files, run processes, or request approvals.",
};

export interface HostedScoutRequestInput {
  readonly requestId: string;
  readonly model: string;
  /** The admitted role class from `validateHostedScoutRequest`. */
  readonly role: HostedRole;
  readonly request: HostedScoutRequest;
  /**
   * The full local catalog. Only the entries the gate admitted are serialized:
   * handing the root's catalog here is safe by construction.
   */
  readonly catalog: readonly ModelToolSchema[];
  readonly reasoningMode?: ReasoningMode;
  readonly reasoningEffort?: ReasoningEffort;
  readonly maxOutputTokens?: number;
  readonly safetyIdentifier?: string;
}

export type HostedScoutRequestBuild =
  | { readonly ok: true; readonly request: ModelRequest }
  | { readonly ok: false; readonly reason: string };

/**
 * Build the separate read-only Responses request for a hosted scout subtree.
 *
 * The request deliberately shares nothing with the root turn: no history, no
 * `previousResponseId`, and `reasoning.context` scoped to `current_turn` so a
 * scout's reasoning never accretes into the parent's persisted scope. It carries
 * no hosted tools either — a scout that could reach `web_search` or
 * `image_generation` would have an external side effect the gate never admitted.
 */
export function buildHostedScoutRequest(input: HostedScoutRequestInput): HostedScoutRequestBuild {
  const admitted = input.request.requestedTools;
  if (admitted === undefined) {
    return { ok: false, reason: "hosted scout request carries no admitted catalog" };
  }
  // The gate is the authority on what is read-only, so the builder re-checks
  // against it rather than trusting that the caller passed a narrowed list.
  const readOnly = new Set<string>(PROGRAM_TOOL_ALLOWLIST);
  const outside = admitted.filter((tool) => !readOnly.has(tool));
  if (outside.length > 0) {
    return { ok: false, reason: `hosted scout catalog is not read-only: ${outside.join(", ")}` };
  }
  const wanted = new Set(admitted);
  const tools = input.catalog.filter((tool) => wanted.has(tool.name));
  const missing = admitted.filter((tool) => !tools.some((entry) => entry.name === tool));
  if (missing.length > 0) {
    return { ok: false, reason: `hosted scout catalog is missing admitted tool(s): ${missing.join(", ")}` };
  }
  return {
    ok: true,
    request: {
      requestId: input.requestId,
      model: input.model,
      input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: ROLE_BRIEF[input.role] }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: input.request.prompt }] },
      ],
      // Deferred loading and programmatic routing are the root turn's concerns;
      // a scout gets the schema outright so it cannot need a second round trip.
      tools: tools.map(({ deferLoading: _deferLoading, namespace: _namespace, allowedCallers: _allowedCallers, ...tool }) => tool),
      hostedTools: [],
      reasoning: {
        mode: input.reasoningMode ?? "standard",
        effort: input.reasoningEffort ?? "low",
        summary: "none",
        // §5.6: the scout is a separate request, so its reasoning is scoped to
        // its own turn and never merges into the parent's persisted scope.
        context: "current_turn",
      },
      maxOutputTokens: Math.max(
        1,
        Math.min(
          input.maxOutputTokens ?? DEFAULT_HOSTED_SCOUT_POLICY.maxTokensPerAgent,
          input.request.requestedTokens ?? DEFAULT_HOSTED_SCOUT_POLICY.maxTokensPerAgent,
        ),
      ),
      // §10.6: a scout owns no session state either.
      store: false,
      parallelToolCalls: true,
      taskEpochId: input.request.taskEpochId,
      callerId: input.request.callerId,
      ...(input.safetyIdentifier !== undefined ? { safetyIdentifier: input.safetyIdentifier } : {}),
    },
  };
}

/**
 * What the host must supply to actually run a hosted scout subtree: a way to
 * stream a Responses request, and a way to execute one admitted read-only tool
 * call. The executor is the host's, because a scout's reads still go through the
 * same permission layer and read cache the root turn uses — a hosted lane is not
 * a way around either.
 */
export interface HostedScoutExecution {
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
  callTool(
    call: { readonly callId: string; readonly name: string; readonly argumentsText: string },
    signal: AbortSignal,
  ): Promise<string>;
}

export interface HostedScoutRunOptions extends Omit<HostedScoutRequestInput, "requestId" | "role" | "request"> {
  readonly execution: HostedScoutExecution;
  /** Bounded provider round trips before the scout must report (§5.6 depth 1). */
  readonly maxRounds?: number;
}

export interface HostedScoutRunResult {
  readonly text: string;
  readonly evidenceLocators: readonly string[];
  readonly tokenUsage: number;
}

/**
 * Drive one hosted scout subtree over the separate read-only request.
 *
 * The loop is deliberately small: the scout reads, the host executes the read,
 * and the scout reports. Anything the provider asks for that is not in the
 * admitted catalog is refused in-band rather than executed, because the catalog
 * the gate produced is the whole authority here — a provider that names a tool
 * outside it is describing a request that was never admitted.
 */
export async function runHostedScout(
  role: HostedRole,
  request: HostedScoutRequest,
  options: HostedScoutRunOptions,
  signal: AbortSignal,
): Promise<HostedScoutRunResult> {
  const admitted = new Set(request.requestedTools ?? []);
  const evidenceLocators: string[] = [];
  let text = "";
  let tokenUsage = 0;
  const maxRounds = Math.max(1, options.maxRounds ?? 4);
  let input: ModelRequest["input"] | undefined;

  for (let round = 0; round < maxRounds; round += 1) {
    if (signal.aborted) throw new Error("hosted scout cancelled");
    const built = buildHostedScoutRequest({
      ...options,
      requestId: `hosted_${request.agentId}_${String(round)}`,
      role,
      request,
    });
    if (!built.ok) throw new Error(built.reason);
    const outbound = input === undefined ? built.request : { ...built.request, input };
    const pending: Array<{ readonly callId: string; readonly name: string; readonly argumentsText: string }> = [];
    for await (const event of options.execution.stream(outbound, signal)) {
      if (event.type === "text.delta") text += event.text;
      else if (event.type === "tool.call.completed") pending.push(event.call);
      else if (event.type === "usage") tokenUsage += Math.max(0, event.usage.totalTokens);
      else if (event.type === "response.failed") throw new Error(`hosted scout request failed: ${event.error.message}`);
      else if (event.type === "response.incomplete") throw new Error(`hosted scout request was incomplete: ${event.reason}`);
    }
    if (pending.length === 0) break;

    const outputs: ModelRequest["input"] = [...outbound.input];
    for (const call of pending) {
      outputs.push({ type: "function_call", callId: call.callId, name: call.name, argumentsText: call.argumentsText });
      if (!admitted.has(call.name)) {
        // Refused in-band so the scout can adjust, rather than thrown: a single
        // out-of-catalog guess should not discard the reads it already has.
        outputs.push({
          type: "function_call_output",
          callId: call.callId,
          output: JSON.stringify({ error: `'${call.name}' is not in this scout's read-only catalog` }),
        });
        continue;
      }
      const output = await options.execution.callTool(call, signal);
      outputs.push({ type: "function_call_output", callId: call.callId, output });
      evidenceLocators.push(`${call.name} ${call.argumentsText}`);
    }
    input = outputs;
  }

  return { text, evidenceLocators: [...new Set(evidenceLocators)], tokenUsage };
}
