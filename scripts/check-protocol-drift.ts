#!/usr/bin/env bun
/**
 * Protocol drift check — PRD §20.11, §19.9.
 *
 * §20.11 names `schemas/` the source of truth and asks for generated types on both
 * sides. This repository takes the other half of that bargain: the constants are
 * hand-written in each language, and *this script is the generator's replacement* —
 * it fails the build when the three copies disagree.
 *
 * That choice is deliberate. A code generator in the build path means a build step
 * that can silently produce something nobody reviewed, and §19.9 already forbids the
 * release path from fetching anything. A check is weaker than generation in one way
 * (someone must write the constant twice) and stronger in another: the Rust and
 * TypeScript definitions stay idiomatic, readable, and diffable.
 *
 * The Rust side is read as *text* rather than by compiling it, so this runs without a
 * toolchain. That is a real limitation and is stated in the output: it verifies the
 * declared lists, not the dispatcher that consumes them.
 */

import {
  ALL_EVENT_KINDS,
  DEFAULT_READ_MAX_LINES,
  EVENT_SCHEMA_VERSION,
  HEARTBEAT,
  JSONRPC_ERROR_CODES,
  LIMITS,
  NOTIFICATION_METHODS,
  PROTOCOL_VERSION,
  REQUEST_METHODS,
  TOOL_ERROR_CODES,
  defaultsForKind,
} from "@cbc/protocol";
import { defaultConfig } from "@cbc/config-schema";
import { NATIVE_TOOLS } from "@cbc/tool-registry";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

interface Finding {
  readonly area: string;
  readonly detail: string;
}

const failures: Finding[] = [];
const notes: string[] = [];
let checks = 0;

function check(area: string, ok: boolean, detail: string): void {
  checks += 1;
  if (!ok) failures.push({ area, detail });
}

/**
 * Compare two ordered lists.
 *
 * Order matters: both sides document their lists as being "in PRD declaration order",
 * and a reordering is a review signal even though it changes no behaviour.
 */
function sameOrderedList(area: string, label: string, a: readonly string[], b: readonly string[]): void {
  const missing = a.filter((item) => !b.includes(item));
  const extra = b.filter((item) => !a.includes(item));
  const reordered =
    missing.length === 0 && extra.length === 0 && a.join("\u0000") !== b.join("\u0000");

  check(
    area,
    missing.length === 0 && extra.length === 0 && !reordered,
    [
      label,
      missing.length > 0 ? `  missing: ${missing.join(", ")}` : "",
      extra.length > 0 ? `  unexpected: ${extra.join(", ")}` : "",
      reordered ? "  same members, different order" : "",
    ]
      .filter((line) => line.length > 0)
      .join("\n"),
  );
}

async function readText(relative: string): Promise<string> {
  const file = Bun.file(`${ROOT}/${relative}`);
  if (!(await file.exists())) {
    failures.push({ area: "files", detail: `${relative} is missing` });
    return "";
  }
  return await file.text();
}

async function readJson(relative: string): Promise<Record<string, unknown>> {
  const text = await readText(relative);
  if (text.length === 0) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    failures.push({
      area: "files",
      detail: `${relative} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    });
    return {};
  }
}

/**
 * Extract a `pub const NAME: &[&str] = &[ "a", "b" ];` list from Rust source.
 *
 * Deliberately narrow: it matches the exact shape `methods.rs` uses and returns an
 * empty list otherwise, which surfaces as a drift failure rather than a silent pass.
 * A tolerant parser here would be worse than a strict one, because the whole point is
 * to notice when the file stops looking the way it is supposed to.
 */
function rustStringList(source: string, name: string): string[] {
  const pattern = new RegExp(`pub const ${name}: &\\[&str\\] = &\\[([\\s\\S]*?)\\];`);
  const body = pattern.exec(source)?.[1];
  if (body === undefined) return [];
  return [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1] as string);
}

/** Extract a `pub const NAME: <ty> = <literal>;` numeric or string constant. */
function rustScalar(source: string, name: string): string | undefined {
  const pattern = new RegExp(`pub const ${name}:\\s*[^=]+=\\s*([^;]+);`);
  const raw = pattern.exec(source)?.[1]?.trim();
  if (raw === undefined) return undefined;
  return raw.replace(/^"|"$/g, "").replace(/_/g, "");
}

/** Evaluate a simple Rust size expression such as `8 * 1024 * 1024`. */
function rustNumber(source: string, name: string): number | undefined {
  const raw = rustScalar(source, name);
  if (raw === undefined) return undefined;
  if (!/^[\d\s*+]+$/.test(raw)) return undefined;
  return raw
    .split("+")
    .map((term) => term.split("*").reduce((product, part) => product * Number(part.trim()), 1))
    .reduce((sum, term) => sum + term, 0);
}

/** Pull `$defs.<name>.enum` out of a schema document. */
function schemaEnum(schema: Record<string, unknown>, path: readonly string[]): string[] {
  let node: unknown = schema;
  for (const segment of path) {
    if (typeof node !== "object" || node === null) return [];
    node = (node as Record<string, unknown>)[segment];
  }
  if (typeof node !== "object" || node === null) return [];
  const values = (node as { enum?: unknown }).enum;
  return Array.isArray(values) ? values.filter((v): v is string => typeof v === "string") : [];
}

function schemaConst(schema: Record<string, unknown>, path: readonly string[]): unknown {
  let node: unknown = schema;
  for (const segment of path) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  if (typeof node !== "object" || node === null) return undefined;
  return (node as { const?: unknown }).const;
}

function schemaDefault(schema: Record<string, unknown>, path: readonly string[]): unknown {
  let node: unknown = schema;
  for (const segment of path) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  if (typeof node !== "object" || node === null) return undefined;
  return (node as { default?: unknown }).default;
}

// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const rustMethods = await readText("crates/cbc-protocol/src/methods.rs");
  const rustFs = await readText("crates/cbc-fs/src/lib.rs");
  const rustLimits = await readText("crates/cbc-protocol/src/limits.rs");
  const rustJsonRpc = await readText("crates/cbc-protocol/src/jsonrpc.rs");

  const rpcSchema = await readJson("schemas/protocol/rpc.schema.json");
  const handshakeSchema = await readJson("schemas/protocol/handshake.schema.json");
  const eventSchema = await readJson("schemas/events/event.schema.json");
  const configSchema = await readJson("schemas/config/config.schema.json");
  const toolSchema = await readJson("schemas/tools/tool.schema.json");

  // ---- §20.3 request methods ----
  const rustRequests = rustStringList(rustMethods, "REQUEST_METHODS");
  const schemaRequests = schemaEnum(rpcSchema, ["$defs", "requestMethod"]);
  sameOrderedList("protocol.requests", "TypeScript vs Rust", REQUEST_METHODS, rustRequests);
  sameOrderedList("protocol.requests", "TypeScript vs schema", REQUEST_METHODS, schemaRequests);
  check(
    "protocol.requests",
    // §20.3 lists 39. `fs.transaction.rollback_to_checkpoint` is the 40th, added for
    // the §11.2 self-correction loop; `workspace.trust.{list,set,remove}` are the
    // 41st–43rd, so the CLI manages trust through the runtime (P0-01);
    // `session.{list,resolve,set_status,export,fork,delete}` are the 44th–49th (P0-05); and
    // `runtime.cancel`, `runtime.capability.issue`, `fs.fingerprint`, and
    // `workspace.mode.write` add cancellation, action-bound receipts, preview
    // revision validation, and live plan-mode enforcement.
    REQUEST_METHODS.length === 53,
    `§20.3 plus checkpoint rollback, trust, session, cancel, capability receipts, fingerprint, and live mode is 53 request methods; found ${REQUEST_METHODS.length}`,
  );

  // ---- §20.3 notifications ----
  const rustNotifications = rustStringList(rustMethods, "NOTIFICATION_METHODS");
  const schemaNotifications = schemaEnum(rpcSchema, ["$defs", "notificationMethod"]);
  sameOrderedList(
    "protocol.notifications",
    "TypeScript vs Rust",
    NOTIFICATION_METHODS,
    rustNotifications,
  );
  sameOrderedList(
    "protocol.notifications",
    "TypeScript vs schema",
    NOTIFICATION_METHODS,
    schemaNotifications,
  );
  check(
    "protocol.notifications",
    NOTIFICATION_METHODS.length === 11,
    `§20.3 lists 11 notification methods; found ${NOTIFICATION_METHODS.length}`,
  );

  // ---- mutating and pre-initialize sets exist only in Rust and the schema ----
  sameOrderedList(
    "protocol.mutating",
    "Rust vs schema",
    rustStringList(rustMethods, "MUTATING_METHODS"),
    schemaEnum(rpcSchema, ["$defs", "mutatingMethod"]),
  );
  sameOrderedList(
    "protocol.preInitialize",
    "Rust vs schema",
    rustStringList(rustMethods, "PRE_INITIALIZE_METHODS"),
    schemaEnum(rpcSchema, ["$defs", "preInitializeMethod"]),
  );

  // Every mutating method must actually be a request method, or the runtime would
  // guard something it never receives.
  for (const method of rustStringList(rustMethods, "MUTATING_METHODS")) {
    check(
      "protocol.mutating",
      (REQUEST_METHODS as readonly string[]).includes(method),
      `MUTATING_METHODS contains '${method}', which is not a request method`,
    );
  }

  // ---- §19.12 protocol version ----
  const rustVersion = rustScalar(rustLimits, "PROTOCOL_VERSION");
  check(
    "protocol.version",
    rustVersion === PROTOCOL_VERSION,
    `PROTOCOL_VERSION: TypeScript ${PROTOCOL_VERSION}, Rust ${rustVersion ?? "not found"}`,
  );
  check(
    "protocol.version",
    schemaConst(rpcSchema, ["$defs", "protocolVersion"]) === PROTOCOL_VERSION,
    `schema protocolVersion const is ${String(schemaConst(rpcSchema, ["$defs", "protocolVersion"]))}, expected ${PROTOCOL_VERSION}`,
  );

  // ---- §20.4 limits ----
  const limitPairs: Array<[keyof typeof LIMITS, string]> = [
    ["maxFrameBytes", "MAX_FRAME_BYTES"],
    ["maxJsonDepth", "MAX_JSON_DEPTH"],
    ["maxStringBytes", "MAX_STRING_BYTES"],
    ["maxEventPayloadBytes", "MAX_EVENT_PAYLOAD_BYTES"],
    ["maxOutstandingRequests", "MAX_OUTSTANDING_REQUESTS"],
    ["lengthPrefixBytes", "LENGTH_PREFIX_BYTES"],
  ];
  for (const [tsKey, rustKey] of limitPairs) {
    const rustValue = rustNumber(rustLimits, rustKey);
    check(
      "protocol.limits",
      rustValue === LIMITS[tsKey],
      `${tsKey}: TypeScript ${LIMITS[tsKey]}, Rust ${rustValue ?? "not found"}`,
    );
    check(
      "protocol.limits",
      schemaConst(rpcSchema, ["$defs", "limits", "properties", tsKey]) === LIMITS[tsKey],
      `${tsKey}: schema const ${String(schemaConst(rpcSchema, ["$defs", "limits", "properties", tsKey]))}, TypeScript ${LIMITS[tsKey]}`,
    );
  }

  // ---- §20.5 heartbeat ----
  const heartbeatPairs: Array<[keyof typeof HEARTBEAT, string]> = [
    ["intervalMs", "HEARTBEAT_INTERVAL_MS"],
    ["degradedMs", "HEARTBEAT_DEGRADED_MS"],
    ["fatalMs", "HEARTBEAT_FATAL_MS"],
  ];
  for (const [tsKey, rustKey] of heartbeatPairs) {
    const rustValue = rustNumber(rustLimits, rustKey);
    check(
      "protocol.heartbeat",
      rustValue === HEARTBEAT[tsKey],
      `${tsKey}: TypeScript ${HEARTBEAT[tsKey]}, Rust ${rustValue ?? "not found"}`,
    );
    check(
      "protocol.heartbeat",
      schemaConst(rpcSchema, ["$defs", "heartbeat", "properties", tsKey]) === HEARTBEAT[tsKey],
      `${tsKey}: schema const differs from TypeScript ${HEARTBEAT[tsKey]}`,
    );
  }

  // ---- filesystem read defaults ----
  const rustReadMaxLines = rustNumber(rustFs, "DEFAULT_READ_MAX_LINES");
  check(
    "filesystem.readDefaults",
    rustReadMaxLines === DEFAULT_READ_MAX_LINES,
    `DEFAULT_READ_MAX_LINES: TypeScript ${DEFAULT_READ_MAX_LINES}, Rust ${rustReadMaxLines ?? "not found"}`,
  );
  check(
    "filesystem.readDefaults",
    schemaConst(rpcSchema, ["$defs", "readMaxLines"]) === DEFAULT_READ_MAX_LINES,
    `schema readMaxLines const differs from TypeScript ${DEFAULT_READ_MAX_LINES}`,
  );
  check(
    "filesystem.readDefaults",
    schemaDefault(rpcSchema, ["$defs", "readRequest", "properties", "maxLines"]) ===
      DEFAULT_READ_MAX_LINES,
    `schema fs.read maxLines default differs from TypeScript ${DEFAULT_READ_MAX_LINES}`,
  );
  for (const toolId of ["fs.read", "fs.read_many"]) {
    const readTool = NATIVE_TOOLS.find((tool) => tool.id === toolId);
    const readToolProperties = (
      (readTool?.parameters as Record<string, unknown> | undefined)?.properties as
        | Record<string, unknown>
        | undefined
    );
    const readToolDefault =
      (readToolProperties?.maxLines as { default?: unknown } | undefined)?.default;
    check(
      "filesystem.readDefaults",
      readToolDefault === DEFAULT_READ_MAX_LINES,
      `${toolId} maxLines default is ${String(readToolDefault)}, expected ${DEFAULT_READ_MAX_LINES}`,
    );
  }

  // ---- JSON-RPC error codes ----
  const errorPairs: Array<[keyof typeof JSONRPC_ERROR_CODES, string]> = [
    ["parseError", "PARSE_ERROR"],
    ["invalidRequest", "INVALID_REQUEST"],
    ["methodNotFound", "METHOD_NOT_FOUND"],
    ["invalidParams", "INVALID_PARAMS"],
    ["internalError", "INTERNAL_ERROR"],
    ["pathOutsideWorkspace", "PATH_OUTSIDE_WORKSPACE"],
    ["hashMismatch", "HASH_MISMATCH"],
    ["pathChanged", "PATH_CHANGED"],
    ["notFound", "NOT_FOUND"],
    ["alreadyExists", "ALREADY_EXISTS"],
    ["unsupportedEncoding", "UNSUPPORTED_ENCODING"],
    ["outputLimit", "OUTPUT_LIMIT"],
    ["timeout", "TIMEOUT"],
    ["cancelled", "CANCELLED"],
    ["processExitNonzero", "PROCESS_EXIT_NONZERO"],
    ["sandboxUnavailable", "SANDBOX_UNAVAILABLE"],
    ["networkDenied", "NETWORK_DENIED"],
    ["transactionConflict", "TRANSACTION_CONFLICT"],
    ["protocolIncompatible", "PROTOCOL_INCOMPATIBLE"],
    ["leaseViolation", "LEASE_VIOLATION"],
    ["resourceLimit", "RESOURCE_LIMIT"],
    ["notInitialized", "NOT_INITIALIZED"],
    ["tooManyRequests", "TOO_MANY_REQUESTS"],
    ["invalidArgument", "INVALID_ARGUMENT"],
    ["permissionDenied", "PERMISSION_DENIED"],
  ];
  for (const [tsKey, rustKey] of errorPairs) {
    const rustValue = rustScalar(rustJsonRpc, rustKey);
    check(
      "protocol.errorCodes",
      rustValue !== undefined && Number(rustValue) === JSONRPC_ERROR_CODES[tsKey],
      `${tsKey}: TypeScript ${JSONRPC_ERROR_CODES[tsKey]}, Rust ${rustValue ?? "not found"}`,
    );
    check(
      "protocol.errorCodes",
      schemaConst(rpcSchema, ["$defs", "errorCodes", "properties", tsKey]) ===
        JSONRPC_ERROR_CODES[tsKey],
      `${tsKey}: schema const differs from TypeScript ${JSONRPC_ERROR_CODES[tsKey]}`,
    );
  }
  check(
    "protocol.errorCodes",
    Object.keys(JSONRPC_ERROR_CODES).length === errorPairs.length,
    `JSONRPC_ERROR_CODES has ${Object.keys(JSONRPC_ERROR_CODES).length} entries but ${errorPairs.length} are checked; add the new one here`,
  );

  // ---- §12.10 taxonomy ----
  sameOrderedList(
    "tools.taxonomy",
    "TypeScript vs schema",
    TOOL_ERROR_CODES,
    schemaEnum(rpcSchema, ["$defs", "toolErrorCode"]),
  );

  // ---- §20.2 handshake ----
  for (const shape of ["initializeParams", "initializeResult", "runtimeCapabilities"]) {
    check(
      "protocol.handshake",
      typeof (handshakeSchema.$defs as Record<string, unknown> | undefined)?.[shape] === "object",
      `handshake schema is missing $defs.${shape}`,
    );
  }
  // The Rust struct is the authority on field names; check the ones §20.2 spells out.
  const rustHandshake = await readText("crates/cbc-protocol/src/handshake.rs");
  for (const field of ["protocol_version", "runtime_version", "workspace_id", "sandbox_level"]) {
    check(
      "protocol.handshake",
      rustHandshake.includes(field),
      `crates/cbc-protocol/src/handshake.rs no longer declares ${field}`,
    );
  }

  // ---- §20.7 event kinds ----
  sameOrderedList(
    "events.kinds",
    "TypeScript vs schema",
    ALL_EVENT_KINDS,
    schemaEnum(eventSchema, ["$defs", "kind"]),
  );
  check(
    "events.version",
    schemaConst(eventSchema, ["properties", "schemaVersion"]) === EVENT_SCHEMA_VERSION,
    `event schemaVersion const differs from ${EVENT_SCHEMA_VERSION}`,
  );

  // §20.9: every kind whose default durability is `journaled` must be able to say so.
  const levels = schemaEnum(eventSchema, ["$defs", "level"]);
  const visibilities = schemaEnum(eventSchema, ["$defs", "visibility"]);
  const durabilities = schemaEnum(eventSchema, ["$defs", "durability"]);
  for (const kind of ALL_EVENT_KINDS) {
    const defaults = defaultsForKind(kind);
    check(
      "events.defaults",
      levels.includes(defaults.level),
      `${kind} defaults to level '${defaults.level}', which the schema does not allow`,
    );
    check(
      "events.defaults",
      visibilities.includes(defaults.visibility),
      `${kind} defaults to visibility '${defaults.visibility}', which the schema does not allow`,
    );
    check(
      "events.defaults",
      durabilities.includes(defaults.durability),
      `${kind} defaults to durability '${defaults.durability}', which the schema does not allow`,
    );
  }

  // ---- §21.4 config ----
  const config = defaultConfig() as unknown as Record<string, unknown>;
  const configProperties = (configSchema.properties ?? {}) as Record<string, unknown>;
  sameOrderedList(
    "config.sections",
    "defaultConfig() vs schema",
    Object.keys(config),
    Object.keys(configProperties),
  );

  for (const [section, value] of Object.entries(config)) {
    // `mcpServers` and `keymap` are open maps, so their keys are data rather than
    // schema. Comparing them would compare a user's servers against a fixed list.
    if (section === "mcpServers" || section === "keymap") continue;
    if (typeof value !== "object" || value === null) continue;

    const schemaSection = configProperties[section] as
      | { properties?: Record<string, unknown>; required?: string[] }
      | undefined;
    if (schemaSection?.properties === undefined) {
      failures.push({ area: "config.keys", detail: `schema has no properties for '${section}'` });
      continue;
    }
    const defaultKeys = Object.keys(value as Record<string, unknown>);
    for (const key of defaultKeys) {
      check(
        "config.keys",
        Object.prototype.hasOwnProperty.call(schemaSection.properties, key),
        `${section}: defaultConfig() key '${key}' is absent from schema`,
      );
    }
    // Every concrete default must be declared required, so a partial config cannot
    // leave a permission-bearing field undefined.
    sameOrderedList(
      "config.required",
      `${section}: schema required list`,
      defaultKeys,
      schemaSection.required ?? [],
    );
  }

  // ---- §12.2 native tools ----
  const schemaToolIds = schemaEnum(toolSchema, ["$defs", "nativeToolId"]);
  sameOrderedList(
    "tools.catalog",
    "NATIVE_TOOLS vs schema",
    NATIVE_TOOLS.map((tool) => tool.id),
    schemaToolIds,
  );

  // §12.4: a strict schema on every tool, checked against the real catalog rather
  // than against the schema's own description of one.
  for (const tool of NATIVE_TOOLS) {
    const parameters = tool.parameters as Record<string, unknown>;
    check(
      "tools.strictSchema",
      parameters.type === "object",
      `${tool.id}: parameters.type is ${String(parameters.type)}, expected "object"`,
    );
    check(
      "tools.strictSchema",
      parameters.additionalProperties === false,
      `${tool.id}: §12.4 requires additionalProperties: false`,
    );
    check(
      "tools.strictSchema",
      Array.isArray(parameters.required),
      `${tool.id}: parameters.required must be an array, even when empty`,
    );
    check(
      "tools.risk",
      riskIndex(tool.maxRisk) >= riskIndex(tool.defaultRisk),
      `${tool.id}: maxRisk ${tool.maxRisk} is below defaultRisk ${tool.defaultRisk}`,
    );
  }

  // ---- changelog presence (§20.11) ----
  const changelog = await readText("schemas/CHANGELOG.md");
  check(
    "schemas.changelog",
    changelog.includes(`protocol ${PROTOCOL_VERSION}`),
    `schemas/CHANGELOG.md has no entry for protocol ${PROTOCOL_VERSION}`,
  );
  check(
    "schemas.changelog",
    changelog.includes(`events ${EVENT_SCHEMA_VERSION}`),
    `schemas/CHANGELOG.md has no entry for events ${EVENT_SCHEMA_VERSION}`,
  );

  notes.push(
    "Rust constants are read as source text, so this verifies the declared lists rather than the dispatcher that consumes them. `cargo test -p cbc-protocol` covers the dispatcher.",
  );

  // ---- report ----
  if (failures.length === 0) {
    console.log(`schemas: ${checks} checks passed`);
    for (const note of notes) console.log(`note: ${note}`);
    return 0;
  }

  const byArea = new Map<string, string[]>();
  for (const failure of failures) {
    const list = byArea.get(failure.area) ?? [];
    list.push(failure.detail);
    byArea.set(failure.area, list);
  }

  console.error(`schemas: ${failures.length} of ${checks} checks failed\n`);
  for (const [area, details] of [...byArea].sort()) {
    console.error(`${area}`);
    for (const detail of details) {
      for (const line of detail.split("\n")) console.error(`  ${line}`);
    }
    console.error("");
  }
  console.error(
    "Update packages/protocol-ts, crates/cbc-protocol, and schemas/ together, then record the change in schemas/CHANGELOG.md.",
  );
  return 1;
}

const RISK_ORDER = ["R0", "R1", "R2", "R3", "R4", "R5", "R6"];

function riskIndex(risk: string): number {
  return RISK_ORDER.indexOf(risk);
}

if (import.meta.main) {
  process.exit(await main());
}

export { main as checkProtocolDrift };
