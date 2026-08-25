/**
 * Strict manifest validation for plugin packages.
 *
 * Manifest requests are not grants. This validator proves only that a package
 * describes a bounded, reproducible request; the runtime remains responsible
 * for signature verification, scope policy, and effective grants.
 */

import {
  PLUGIN_HOOK_KINDS,
  PLUGIN_SCHEMA_VERSION,
  type PluginManifest,
  type PluginRiskClass,
  type PluginToolSideEffect,
} from "./contracts.ts";

const MAX_PERMISSION_ENTRIES = 128;
const MAX_CONTRIBUTIONS = 128;
const MAX_MANIFEST_TEXT_BYTES = 4_096;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const ID_SEGMENT = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const OPAQUE_ID = /^[A-Za-z0-9_.-]+$/u;

export class PluginManifestError extends Error {
  readonly code = "PLUGIN_MANIFEST_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "PluginManifestError";
  }
}

/**
 * Fail closed on malformed, ambiguous, or path-traversing declarations before
 * a package can enter the installation verifier or durable store.
 */
export function validatePluginManifest(manifest: PluginManifest): void {
  const root = record(manifest, "manifest");
  rejectUnknown(root, [
    "schemaVersion",
    "id",
    "name",
    "version",
    "publisher",
    "description",
    "license",
    "runtime",
    "compatibility",
    "hooks",
    "tools",
    "commands",
    "contextProviders",
    "ui",
    "permissions",
    "limits",
    "integrity",
    "signature",
  ], "manifest");

  if (root.schemaVersion !== PLUGIN_SCHEMA_VERSION) {
    fail("manifest.schemaVersion must be 1.0");
  }
  const id = pluginId(root.id);
  const publisher = idSegment(root.publisher, "manifest.publisher");
  if (publisher !== id.publisher) {
    fail("manifest.publisher must match the publisher segment of manifest.id");
  }
  text(root.name, "manifest.name", 256);
  version(root.version, "manifest.version");
  text(root.description, "manifest.description", MAX_MANIFEST_TEXT_BYTES);
  text(root.license, "manifest.license", 256);
  const runtime = validateRuntime(root.runtime);
  validateCompatibility(root.compatibility);
  validatePermissions(root.permissions);
  validateHooks(root.hooks);
  validateTools(root.tools);
  validateCommands(root.commands);
  validateContextProviders(root.contextProviders);
  validateUi(root.ui);
  validateLimits(root.limits);
  validateIntegrity(root.integrity, runtime.entrypoint);
  validateSignature(root.signature);
}

function validateRuntime(value: unknown): { readonly entrypoint: string } {
  const runtime = record(value, "manifest.runtime");
  rejectUnknown(runtime, ["kind", "entrypoint", "protocolVersion"], "manifest.runtime");
  if (runtime.kind !== "wasi" && runtime.kind !== "stdio") {
    fail("manifest.runtime.kind must be wasi or stdio");
  }
  const entrypoint = relativePackagePath(runtime.entrypoint, "manifest.runtime.entrypoint");
  version(runtime.protocolVersion, "manifest.runtime.protocolVersion");
  return { entrypoint };
}

function validateCompatibility(value: unknown): void {
  const compatibility = record(value, "manifest.compatibility");
  rejectUnknown(compatibility, ["capybara", "platforms"], "manifest.compatibility");
  text(compatibility.capybara, "manifest.compatibility.capybara", 128);
  optionalTextArray(compatibility.platforms, "manifest.compatibility.platforms", 32);
}

function validatePermissions(value: unknown): void {
  const permissions = record(value, "manifest.permissions");
  rejectUnknown(permissions, [
    "events",
    "tools",
    "workspaceRead",
    "workspaceWrite",
    "networkDomains",
    "credentials",
    "artifacts",
    "sessionState",
    "memory",
    "graph",
  ], "manifest.permissions");

  optionalTextArray(permissions.events, "permissions.events", MAX_PERMISSION_ENTRIES);
  optionalTextArray(permissions.tools, "permissions.tools", MAX_PERMISSION_ENTRIES);
  optionalWorkspacePatterns(permissions.workspaceRead, "permissions.workspaceRead");
  optionalWorkspacePatterns(permissions.workspaceWrite, "permissions.workspaceWrite");
  optionalTextArray(permissions.networkDomains, "permissions.networkDomains", MAX_PERMISSION_ENTRIES);
  optionalTextArray(permissions.credentials, "permissions.credentials", MAX_PERMISSION_ENTRIES);

  optionalEnum(permissions.artifacts, "permissions.artifacts", ["none", "read-own", "create"]);
  optionalEnum(permissions.sessionState, "permissions.sessionState", ["none", "read", "write-own"]);
  optionalEnum(permissions.memory, "permissions.memory", ["none", "search", "propose"]);
  optionalEnum(permissions.graph, "permissions.graph", ["none", "observe", "propose-node"]);
}

function validateHooks(value: unknown): void {
  if (value === undefined) return;
  const hooks = records(value, "manifest.hooks", MAX_CONTRIBUTIONS);
  const seen = new Set<string>();
  for (const [index, hook] of hooks.entries()) {
    rejectUnknown(hook, ["kind", "ordinal", "critical"], "manifest.hooks[]");
    const kind = hook.kind;
    if (typeof kind !== "string" || !(PLUGIN_HOOK_KINDS as readonly string[]).includes(kind)) {
      fail("manifest.hooks[" + String(index) + "].kind is unsupported");
    }
    const ordinal = hook.ordinal === undefined ? 0 : nonNegativeInteger(hook.ordinal, "manifest.hooks[].ordinal", 10_000);
    if (hook.critical !== undefined && typeof hook.critical !== "boolean") {
      fail("manifest.hooks[].critical must be boolean");
    }
    const key = kind + ":" + String(ordinal);
    if (seen.has(key)) fail("manifest.hooks contains a duplicate kind and ordinal");
    seen.add(key);
  }
}

function validateTools(value: unknown): void {
  if (value === undefined) return;
  const tools = records(value, "manifest.tools", MAX_CONTRIBUTIONS);
  const ids = new Set<string>();
  for (const tool of tools) {
    rejectUnknown(tool, [
      "id",
      "title",
      "description",
      "parametersSchema",
      "requestedRisk",
      "sideEffect",
      "network",
      "resultSchema",
    ], "manifest.tools[]");
    const id = opaqueId(tool.id, "manifest.tools[].id");
    if (ids.has(id)) fail("manifest.tools contains duplicate ids");
    ids.add(id);
    text(tool.title, "manifest.tools[].title", 256);
    text(tool.description, "manifest.tools[].description", MAX_MANIFEST_TEXT_BYTES);
    risk(tool.requestedRisk);
    sideEffect(tool.sideEffect);
    if (typeof tool.network !== "boolean") fail("manifest.tools[].network must be boolean");
    strictObjectSchema(tool.parametersSchema, "manifest.tools[].parametersSchema");
    if (tool.resultSchema !== undefined && !isRecord(tool.resultSchema)) {
      fail("manifest.tools[].resultSchema must be an object when provided");
    }
  }
}

function validateCommands(value: unknown): void {
  if (value === undefined) return;
  const commands = records(value, "manifest.commands", MAX_CONTRIBUTIONS);
  const names = new Set<string>();
  for (const command of commands) {
    rejectUnknown(command, ["name", "aliases", "description", "argumentsSchema", "headless"], "manifest.commands[]");
    const name = opaqueId(command.name, "manifest.commands[].name");
    if (names.has(name)) fail("manifest.commands contains duplicate names");
    names.add(name);
    optionalOpaqueIdArray(command.aliases, "manifest.commands[].aliases", 16);
    text(command.description, "manifest.commands[].description", MAX_MANIFEST_TEXT_BYTES);
    strictObjectSchema(command.argumentsSchema, "manifest.commands[].argumentsSchema");
    if (typeof command.headless !== "boolean") fail("manifest.commands[].headless must be boolean");
  }
}

function validateContextProviders(value: unknown): void {
  if (value === undefined) return;
  const providers = records(value, "manifest.contextProviders", MAX_CONTRIBUTIONS);
  const ids = new Set<string>();
  for (const provider of providers) {
    rejectUnknown(provider, ["id", "title", "description"], "manifest.contextProviders[]");
    const id = opaqueId(provider.id, "manifest.contextProviders[].id");
    if (ids.has(id)) fail("manifest.contextProviders contains duplicate ids");
    ids.add(id);
    text(provider.title, "manifest.contextProviders[].title", 256);
    text(provider.description, "manifest.contextProviders[].description", MAX_MANIFEST_TEXT_BYTES);
  }
}

function validateUi(value: unknown): void {
  if (value === undefined) return;
  const ui = record(value, "manifest.ui");
  rejectUnknown(ui, ["drawers", "statusItems"], "manifest.ui");
  if (ui.drawers !== undefined) {
    const ids = new Set<string>();
    for (const drawer of records(ui.drawers, "manifest.ui.drawers", 32)) {
      rejectUnknown(drawer, ["id", "title", "dataSource"], "manifest.ui.drawers[]");
      const id = opaqueId(drawer.id, "manifest.ui.drawers[].id");
      if (ids.has(id)) fail("manifest.ui.drawers contains duplicate ids");
      ids.add(id);
      text(drawer.title, "manifest.ui.drawers[].title", 256);
      opaqueId(drawer.dataSource, "manifest.ui.drawers[].dataSource");
    }
  }
  if (ui.statusItems !== undefined) {
    const ids = new Set<string>();
    for (const status of records(ui.statusItems, "manifest.ui.statusItems", 32)) {
      rejectUnknown(status, ["id", "label", "eventKinds"], "manifest.ui.statusItems[]");
      const id = opaqueId(status.id, "manifest.ui.statusItems[].id");
      if (ids.has(id)) fail("manifest.ui.statusItems contains duplicate ids");
      ids.add(id);
      text(status.label, "manifest.ui.statusItems[].label", 256);
      textArray(status.eventKinds, "manifest.ui.statusItems[].eventKinds", 64);
    }
  }
}

function validateLimits(value: unknown): void {
  if (value === undefined) return;
  const limits = record(value, "manifest.limits");
  rejectUnknown(limits, ["beforeHookMs", "afterHookMs", "maxOutputBytes", "maxStateBytes"], "manifest.limits");
  optionalPositiveInteger(limits.beforeHookMs, "manifest.limits.beforeHookMs", 60_000);
  optionalPositiveInteger(limits.afterHookMs, "manifest.limits.afterHookMs", 60_000);
  optionalPositiveInteger(limits.maxOutputBytes, "manifest.limits.maxOutputBytes", 16 * 1024 * 1024);
  optionalPositiveInteger(limits.maxStateBytes, "manifest.limits.maxStateBytes", 16 * 1024 * 1024);
}

function validateIntegrity(value: unknown, entrypoint: string): void {
  const integrity = record(value, "manifest.integrity");
  rejectUnknown(integrity, ["files", "packageDigest"], "manifest.integrity");
  const files = record(integrity.files, "manifest.integrity.files");
  const paths = Object.keys(files);
  if (paths.length === 0 || paths.length > 4_096) {
    fail("manifest.integrity.files must contain 1 to 4096 files");
  }
  for (const path of paths) {
    relativePackagePath(path, "manifest.integrity.files path");
    digest(files[path], "manifest.integrity.files digest");
  }
  if (!(entrypoint in files)) {
    fail("manifest.runtime.entrypoint must be covered by manifest.integrity.files");
  }
  digest(integrity.packageDigest, "manifest.integrity.packageDigest");
}

function validateSignature(value: unknown): void {
  if (value === undefined) return;
  const signature = record(value, "manifest.signature");
  rejectUnknown(signature, ["keyId", "algorithm", "signature"], "manifest.signature");
  opaqueId(signature.keyId, "manifest.signature.keyId");
  text(signature.algorithm, "manifest.signature.algorithm", 128);
  text(signature.signature, "manifest.signature.signature", MAX_MANIFEST_TEXT_BYTES);
}

function strictObjectSchema(value: unknown, name: string): void {
  const schema = record(value, name);
  if (schema.type !== "object" || schema.additionalProperties !== false) {
    throw new PluginManifestError(name + " must be a strict object schema");
  }
}

function pluginId(value: unknown): { readonly publisher: string; readonly name: string } {
  if (typeof value !== "string") fail("manifest.id must be a canonical publisher/name identifier");
  const parts = value.split("/");
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
    fail("manifest.id must be a canonical publisher/name identifier");
  }
  return {
    publisher: idSegment(parts[0], "manifest.id publisher"),
    name: idSegment(parts[1], "manifest.id name"),
  };
}

function idSegment(value: unknown, name: string): string {
  if (typeof value !== "string" || !ID_SEGMENT.test(value)) {
    fail(name + " must be a lowercase identifier");
  }
  return value;
}

function opaqueId(value: unknown, name: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 128
    || value.trim() !== value
    || !OPAQUE_ID.test(value)
  ) {
    fail(name + " must be a bounded opaque identifier");
  }
  return value;
}

function relativePackagePath(value: unknown, name: string): string {
  const path = text(value, name, 512);
  if (
    path.startsWith("/")
    || path.includes("\\")
    || path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    fail(name + " must be a package-relative path without traversal");
  }
  return path;
}

function version(value: unknown, name: string): string {
  const parsed = text(value, name, 128);
  if (!SEMVER.test(parsed)) fail(name + " must be a semantic version");
  return parsed;
}

function digest(value: unknown, name: string): string {
  if (typeof value !== "string" || !SHA256_DIGEST.test(value)) {
    fail(name + " must be a lowercase sha256 digest");
  }
  return value;
}

function risk(value: unknown): PluginRiskClass {
  if (value === "R0" || value === "R1" || value === "R2" || value === "R3" || value === "R4") {
    return value;
  }
  fail("manifest.tools[].requestedRisk is unsupported");
}

function sideEffect(value: unknown): PluginToolSideEffect {
  if (value === "read" || value === "write" || value === "destructive" || value === "external" || value === "unknown") {
    return value;
  }
  fail("manifest.tools[].sideEffect is unsupported");
}

function optionalEnum(value: unknown, name: string, allowed: readonly string[]): void {
  if (value === undefined) return;
  if (typeof value !== "string" || !allowed.includes(value)) {
    fail(name + " is unsupported");
  }
}

function optionalWorkspacePatterns(value: unknown, name: string): void {
  if (value === undefined) return;
  for (const pattern of textArray(value, name, MAX_PERMISSION_ENTRIES)) {
    if (
      pattern.startsWith("/")
      || pattern.includes("\\")
      || pattern.split("/").some((segment) => segment === "..")
    ) {
      fail(name + " must not escape the workspace");
    }
  }
}

function optionalTextArray(value: unknown, name: string, maximum: number): void {
  if (value === undefined) return;
  textArray(value, name, maximum);
}

function optionalOpaqueIdArray(value: unknown, name: string, maximum: number): void {
  if (value === undefined) return;
  const values = array(value, name, maximum);
  const seen = new Set<string>();
  for (const item of values) {
    const id = opaqueId(item, name);
    if (seen.has(id)) fail(name + " must not contain duplicates");
    seen.add(id);
  }
}

function textArray(value: unknown, name: string, maximum: number): readonly string[] {
  const values = array(value, name, maximum);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of values) {
    const parsed = text(item, name, 256);
    if (seen.has(parsed)) fail(name + " must not contain duplicates");
    seen.add(parsed);
    out.push(parsed);
  }
  return out;
}

function records(value: unknown, name: string, maximum: number): readonly Record<string, unknown>[] {
  return array(value, name, maximum).map((item) => record(item, name + "[]"));
}

function array(value: unknown, name: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    fail(name + " must be an array with at most " + String(maximum) + " items");
  }
  return value;
}

function optionalPositiveInteger(value: unknown, name: string, maximum: number): void {
  if (value === undefined) return;
  const parsed = nonNegativeInteger(value, name, maximum);
  if (parsed === 0) fail(name + " must be greater than zero");
}

function nonNegativeInteger(value: unknown, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0 || value > maximum) {
    fail(name + " must be a bounded non-negative integer");
  }
  return value;
}

function text(value: unknown, name: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || value.trim() !== value
    || new TextEncoder().encode(value).byteLength > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(name + " must be bounded non-empty text");
  }
  return value;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) fail(name + " must be an object");
  return value;
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(name + " contains an unsupported field");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new PluginManifestError(message);
}
