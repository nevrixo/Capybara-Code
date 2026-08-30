import type { PluginPermissionRequest } from "@cbc/plugin-sdk";

export const CAPYBARA_PACKAGE_SCHEMA_VERSION = "1.0" as const;
export const CAPYBARA_PACKAGE_LOCK_SCHEMA_VERSION = "1.0" as const;

export type PackageSourceKind = "registry" | "local-path";
export type PackageInstallScope = "project" | "user";

export interface CapybaraPackageContents {
  readonly plugins?: readonly string[];
  readonly skills?: readonly string[];
  readonly agents?: readonly string[];
  readonly prompts?: readonly string[];
  readonly themes?: readonly string[];
  readonly hooks?: readonly string[];
  readonly schemas?: readonly string[];
  readonly assets?: readonly string[];
}

export interface CapybaraPackageSignature {
  readonly keyId: string;
  readonly algorithm: "ed25519";
  readonly value: string;
}

export interface CapybaraPackageManifest {
  readonly schemaVersion: typeof CAPYBARA_PACKAGE_SCHEMA_VERSION;
  readonly id: string;
  readonly version: string;
  readonly capybara: string;
  readonly contents: CapybaraPackageContents;
  readonly permissions: PluginPermissionRequest;
  readonly integrity: {
    readonly files: Readonly<Record<string, string>>;
    readonly packageDigest: string;
  };
  readonly signature?: CapybaraPackageSignature;
}

export interface PackageFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface ResolvedPackage {
  readonly source: string;
  readonly sourceKind: PackageSourceKind;
  readonly manifestBytes: Uint8Array;
  readonly files: readonly PackageFile[];
  readonly signatureVerified: boolean;
}

export interface VerifiedPackage {
  readonly manifest: CapybaraPackageManifest;
  readonly manifestDigest: string;
  readonly packageDigest: string;
  readonly fileDigests: Readonly<Record<string, string>>;
  readonly totalBytes: number;
  readonly source: string;
  readonly sourceKind: PackageSourceKind;
  readonly signatureVerified: boolean;
}

export interface PackageLockEntry {
  readonly version: string;
  readonly source: string;
  readonly sourceKind: PackageSourceKind;
  readonly packageDigest: string;
  readonly manifestDigest: string;
  readonly signature?: {
    readonly keyId: string;
    readonly verified: true;
  };
  readonly grants: PluginPermissionRequest;
  readonly contents: CapybaraPackageContents;
}

export interface PackageLockfile {
  readonly schemaVersion: typeof CAPYBARA_PACKAGE_LOCK_SCHEMA_VERSION;
  readonly packages: Readonly<Record<string, PackageLockEntry>>;
}

export interface PackageRequest {
  readonly source: string;
  readonly scope: PackageInstallScope;
  readonly grants?: PluginPermissionRequest;
}

export interface PackageRequestFile {
  readonly schemaVersion: "1.0";
  readonly packages: readonly PackageRequest[];
}

export type PackageOperationStatus =
  | "completed"
  | "failed"
  | "rolled-back"
  | "removed"
  | "verified";

export interface PackageOperationReceipt {
  readonly schemaVersion: "1.0";
  readonly receiptId: string;
  readonly idempotencyKey: string;
  readonly operation: "install" | "update" | "remove" | "verify" | "bootstrap";
  readonly packageId?: string;
  readonly source?: string;
  readonly status: PackageOperationStatus;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly lockDigestBefore: string;
  readonly lockDigestAfter: string;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export function emptyPackageLockfile(): PackageLockfile {
  return Object.freeze({ schemaVersion: "1.0", packages: Object.freeze({}) });
}
