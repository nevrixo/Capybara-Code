/**
 * Isolated plugin runtime with WASI-equivalent ambient authority.
 *
 * Plugins receive no process environment, no unrestricted filesystem, and no
 * network. Host imports are capability-checked against the effective grant.
 * A missing or hostile import fails closed; stdio is never a fallback.
 */

import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { pathToFileURL } from "node:url";

import { assertNoAmbientAuthority, type EffectivePluginOperation } from "./authority.ts";

export class WasiRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WasiRuntimeError";
    this.code = code;
  }
}

export interface IsolatedPluginInvoke {
  readonly pluginId: string;
  readonly entrypoint: string;
  readonly method: string;
  readonly params?: unknown;
  readonly timeoutMs: number;
  readonly grants: EffectivePluginOperation;
  readonly sourceText?: string;
  /** Host-supplied granted workspace read. Never ambient filesystem access. */
  readonly readFile?: (path: string) => string;
}

export interface IsolatedPluginResult {
  readonly ok: true;
  readonly result: unknown;
  readonly durationMs: number;
}

/**
 * Run a WASI-kind plugin with no ambient secrets or workspace access.
 */
export async function invokeIsolatedPlugin(input: IsolatedPluginInvoke): Promise<IsolatedPluginResult> {
  assertIsolateAuthority(input.grants);
  const started = Date.now();
  const source = input.sourceText ?? readEntrypoint(input.entrypoint);
  if (input.entrypoint.endsWith(".wasm") || source.startsWith("\0asm")) {
    const result = await invokeWasm(source, input);
    return { ok: true, result, durationMs: Math.max(0, Date.now() - started) };
  }
  const result = invokeJsSandbox(source, input);
  return { ok: true, result, durationMs: Math.max(0, Date.now() - started) };
}

function readEntrypoint(entrypoint: string): string {
  try {
    return readFileSync(entrypoint, "utf8");
  } catch (error) {
    throw new WasiRuntimeError(
      "PLUGIN_ENTRYPOINT_MISSING",
      `wasi entrypoint is not readable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function invokeJsSandbox(source: string, input: IsolatedPluginInvoke): unknown {
  const host = Object.freeze({
    pluginId: input.pluginId,
    method: input.method,
    params: input.params ?? {},
    grants: Object.freeze({ ...input.grants }),
    log: () => undefined,
    env: Object.freeze({}),
    read: (path: unknown) => {
      if (typeof path !== "string") {
        throw new WasiRuntimeError("PLUGIN_INVALID_PATH", "read path must be a string");
      }
      assertGrantedRead(path, input.grants);
      if (input.readFile === undefined) {
        throw new WasiRuntimeError("PLUGIN_CAPABILITY_DENIED", "workspace read is not granted to this isolate");
      }
      return input.readFile(path);
    },
    write: (_path: unknown) => {
      throw new WasiRuntimeError("PLUGIN_CAPABILITY_DENIED", "workspace write is denied by default");
    },
    network: () => {
      throw new WasiRuntimeError("PLUGIN_CAPABILITY_DENIED", "network is denied");
    },
  });
  assertIsolateAuthority(input.grants, host);
  const context = createContext({
    capy: host,
    exports: {},
    module: { exports: {} },
    process: undefined,
    require: undefined,
    Buffer: undefined,
    global: undefined,
    globalThis: undefined,
    console: { log: () => undefined, error: () => undefined, warn: () => undefined },
  });
  const wrapped =
    `"use strict";\n${source}\n` +
    `if (typeof handle === "function") { exports.default = handle; }\n` +
    `exports;`;
  let exported: unknown;
  try {
    exported = runInContext(wrapped, context, {
      filename: pathToFileURL(input.entrypoint).href,
      timeout: input.timeoutMs,
    });
  } catch (error) {
    if (isTimeout(error)) {
      throw new WasiRuntimeError("PLUGIN_TIMEOUT", "plugin invocation timed out");
    }
    throw error instanceof WasiRuntimeError
      ? error
      : new WasiRuntimeError("PLUGIN_EXIT", error instanceof Error ? error.message : String(error));
  }
  const handler = resolveHandler(exported, input.method);
  const outcome = handler(input.params ?? {}, host);
  if (outcome !== undefined && typeof (outcome as Promise<unknown>).then === "function") {
    throw new WasiRuntimeError("PLUGIN_PROTOCOL_ERROR", "wasi javascript plugins must return synchronously");
  }
  return outcome;
}

async function invokeWasm(source: string | Buffer, input: IsolatedPluginInvoke): Promise<unknown> {
  const bytes = typeof source === "string" && source.startsWith("\0asm")
    ? Buffer.from(source, "binary")
    : typeof source === "string"
      ? readFileSync(input.entrypoint)
      : source;
  const imports = {
    capy: {
      log: () => undefined,
      env_get: () => 0,
      fs_read: () => {
        throw new WasiRuntimeError("PLUGIN_CAPABILITY_DENIED", "wasm filesystem is denied by default");
      },
      fs_write: () => {
        throw new WasiRuntimeError("PLUGIN_CAPABILITY_DENIED", "wasm filesystem write is denied");
      },
      net_connect: () => {
        throw new WasiRuntimeError("PLUGIN_CAPABILITY_DENIED", "wasm network is denied");
      },
    },
    wasi_snapshot_preview1: deniedWasi(),
    wasi_unstable: deniedWasi(),
  };
  let instance: WebAssembly.Instance;
  try {
    const compiled = await WebAssembly.instantiate(bytes, imports);
    instance = compiled.instance;
  } catch (error) {
    throw new WasiRuntimeError(
      "PLUGIN_WASI_UNSUPPORTED",
      `wasm instantiate failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const exported = instance.exports[input.method] ?? instance.exports.handle ?? instance.exports._start;
  if (typeof exported !== "function") {
    throw new WasiRuntimeError("PLUGIN_PROTOCOL_ERROR", "wasm module does not export the requested method");
  }
  try {
    return exported();
  } catch (error) {
    throw error instanceof WasiRuntimeError
      ? error
      : new WasiRuntimeError("PLUGIN_EXIT", error instanceof Error ? error.message : String(error));
  }
}

function deniedWasi(): Record<string, () => number> {
  const trap = (): number => {
    throw new WasiRuntimeError("PLUGIN_CAPABILITY_DENIED", "ambient WASI import is denied");
  };
  return new Proxy({}, { get: () => trap }) as Record<string, () => number>;
}

function resolveHandler(exported: unknown, method: string): (params: unknown, host: unknown) => unknown {
  const record = asRecord(exported);
  const candidate = record?.[method] ?? record?.default ?? record?.handle;
  if (typeof candidate === "function") {
    return candidate as (params: unknown, host: unknown) => unknown;
  }
  throw new WasiRuntimeError("PLUGIN_PROTOCOL_ERROR", `plugin does not export '${method}'`);
}

function assertIsolateAuthority(grants: EffectivePluginOperation, host?: object): void {
  try {
    assertNoAmbientAuthority(grants, host);
  } catch (error) {
    throw new WasiRuntimeError(
      "PLUGIN_CAPABILITY_DENIED",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function assertGrantedRead(path: string, grants: EffectivePluginOperation): void {
  if (grants.workspaceRead.some((allowed) => path === allowed || path.startsWith(allowed.replace(/\*\*$/, "")))) {
    return;
  }
  throw new WasiRuntimeError("PLUGIN_CAPABILITY_DENIED", `read of '${path}' is not granted`);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && /timed? ?out/i.test(error.message);
}
