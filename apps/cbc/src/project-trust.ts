import { createHash } from "node:crypto";

import { join, type Host } from "./host.ts";

export interface ProjectTrustSnapshot {
  readonly schemaVersion: "2.0";
  readonly projectDigest: string;
  readonly configDigest: string;
  readonly packageManifestDigest: string;
  readonly packageLockDigest: string;
  readonly executableDigest: string;
  readonly capabilityDigest: string;
  readonly requestedCapabilities: readonly string[];
  readonly hasProjectControlFiles: boolean;
}

export class ProjectTrustSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectTrustSnapshotError";
  }
}

const MAX_CONTROL_FILE_BYTES = 1024 * 1024;

export async function captureProjectTrustSnapshot(
  host: Pick<Host, "fs">,
  workspacePath: string,
): Promise<ProjectTrustSnapshot> {
  const root = join(workspacePath, ".capybara");
  const sharedConfig = await readBounded(host, join(root, "config.toml"));
  const localConfig = await readBounded(host, join(root, "config.local.toml"));
  const packageManifest = await readBounded(host, join(root, "packages.json"));
  const packageLock = await readBounded(host, join(root, "packages.lock.json"));
  const configDigest = digest({
    shared: normalizedText(sharedConfig),
    local: normalizedText(localConfig),
  });
  const packageManifestDigest = digest(normalizedText(packageManifest));
  const packageLockDigest = digest(normalizedText(packageLock));
  const executableDeclarations = [
    ...executableLines(sharedConfig),
    ...executableLines(localConfig),
    ...packageExecutableDeclarations(packageManifest),
  ].sort();
  const requestedCapabilities = capabilitySet(
    sharedConfig,
    localConfig,
    packageManifest,
  );
  const executableDigest = digest(executableDeclarations);
  const capabilityDigest = digest(requestedCapabilities);
  const hasProjectControlFiles = [sharedConfig, localConfig, packageManifest, packageLock]
    .some((value) => value !== undefined);
  return Object.freeze({
    schemaVersion: "2.0",
    projectDigest: digest({
      configDigest,
      packageManifestDigest,
      packageLockDigest,
      executableDigest,
      capabilityDigest,
    }),
    configDigest,
    packageManifestDigest,
    packageLockDigest,
    executableDigest,
    capabilityDigest,
    requestedCapabilities: Object.freeze(requestedCapabilities),
    hasProjectControlFiles,
  });
}

export function projectTrustWidening(
  previous: ProjectTrustSnapshot | undefined,
  current: ProjectTrustSnapshot,
): readonly string[] {
  if (previous === undefined) return current.requestedCapabilities;
  const allowed = new Set(previous.requestedCapabilities);
  return current.requestedCapabilities.filter((capability) => !allowed.has(capability));
}

export function projectTrustMatches(
  approved: ProjectTrustSnapshot | undefined,
  current: ProjectTrustSnapshot,
): boolean {
  if (!current.hasProjectControlFiles) return true;
  return approved?.projectDigest === current.projectDigest;
}

async function readBounded(
  host: Pick<Host, "fs">,
  path: string,
): Promise<string | undefined> {
  if (host.fs.readPrefix !== undefined) {
    const prefix = await host.fs.readPrefix(path, MAX_CONTROL_FILE_BYTES);
    if (prefix === undefined) return undefined;
    if (prefix.truncated) {
      throw new ProjectTrustSnapshotError(
        "project control file exceeds the 1 MiB trust inspection limit: " + path,
      );
    }
    return prefix.content;
  }
  const content = await host.fs.read(path);
  if (content !== undefined && Buffer.byteLength(content, "utf8") > MAX_CONTROL_FILE_BYTES) {
    throw new ProjectTrustSnapshotError(
      "project control file exceeds the 1 MiB trust inspection limit: " + path,
    );
  }
  return content;
}

function executableLines(content: string | undefined): string[] {
  if (content === undefined) return [];
  return content
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) =>
      /(?:command|entrypoint|executable|hook|mcp|lsp|network|workspace_write|credential)/iu.test(line)
    );
}

function packageExecutableDeclarations(content: string | undefined): string[] {
  if (content === undefined) return [];
  try {
    const value = JSON.parse(content) as unknown;
    return collectStrings(value)
      .filter((entry) => /(?:plugin|hook|command|entrypoint|\.wasm$)/iu.test(entry))
      .sort();
  } catch {
    return ["invalid-packages-json"];
  }
}

function capabilitySet(
  sharedConfig: string | undefined,
  localConfig: string | undefined,
  packageManifest: string | undefined,
): string[] {
  const text = [sharedConfig ?? "", localConfig ?? "", packageManifest ?? ""].join("\n");
  const capabilities = new Set<string>();
  if (/\bmcp(?:Servers|\.servers)?\b/iu.test(text)) capabilities.add("mcp");
  if (/\blsp(?:Servers|\.servers)?\b/iu.test(text)) capabilities.add("lsp");
  if (/\bplugins?\b|\.wasm\b/iu.test(text)) capabilities.add("plugin-runtime");
  if (/\bhooks?\b/iu.test(text)) capabilities.add("hooks");
  if (
    /networkDomains|network_domains/iu.test(text)
    || /["']?network["']?\s*[:=]\s*["']?(?:allow|ask|full|true)\b/iu.test(text)
  ) {
    capabilities.add("network");
  }
  if (/workspaceWrite|workspace_write/iu.test(text)) capabilities.add("workspace-write");
  if (/credentialScopes|credential_scopes/iu.test(text)) capabilities.add("credentials");
  if (/\bcommand\b|\bentrypoint\b|\bexecutable\b/iu.test(text)) capabilities.add("process");
  return [...capabilities].sort();
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, child]) => [key, ...collectStrings(child)]);
}

function normalizedText(value: string | undefined): string | null {
  return value === undefined ? null : value.replace(/\r\n?/gu, "\n");
}

function digest(value: unknown): string {
  return "sha256:" + createHash("sha256")
    .update(JSON.stringify(canonicalize(value)), "utf8")
    .digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}
