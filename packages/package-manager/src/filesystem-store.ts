import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  emptyPackageLockfile,
  type PackageLockEntry,
  type PackageLockfile,
  type PackageOperationReceipt,
  type ResolvedPackage,
  type VerifiedPackage,
} from "./contracts.ts";
import {
  type PackageActivation,
  type PackageInstallStore,
  type StagedPackage,
} from "./installer.ts";
import {
  validatePackageLockfile,
} from "./verify.ts";

export interface PackageActivationHost {
  activate(input: PackageActivation): Promise<void>;
  healthCheck(input: PackageActivation): Promise<boolean>;
  rollback(packageId: string, previous: PackageLockEntry | undefined): Promise<void>;
}

export interface FileSystemPackageInstallStoreOptions {
  readonly lockfilePath: string;
  readonly cacheRoot: string;
  readonly receiptsPath?: string;
  readonly activationHost: PackageActivationHost;
}

interface ReceiptStore {
  readonly schemaVersion: "1.0";
  readonly receipts: Readonly<Record<string, PackageOperationReceipt>>;
}

export class FileSystemPackageInstallStore implements PackageInstallStore {
  readonly #lockfilePath: string;
  readonly #cacheRoot: string;
  readonly #receiptsPath: string;
  readonly #activationHost: PackageActivationHost;

  constructor(options: FileSystemPackageInstallStoreOptions) {
    this.#lockfilePath = resolve(options.lockfilePath);
    this.#cacheRoot = resolve(options.cacheRoot);
    this.#receiptsPath = resolve(
      options.receiptsPath ?? join(this.#cacheRoot, "operation-receipts.json"),
    );
    this.#activationHost = options.activationHost;
  }

  async readLockfile(): Promise<PackageLockfile> {
    try {
      const parsed = JSON.parse(await readFile(this.#lockfilePath, "utf8")) as PackageLockfile;
      validatePackageLockfile(parsed);
      return parsed;
    } catch (error) {
      if (isMissing(error)) return emptyPackageLockfile();
      throw error;
    }
  }

  async writeLockfileAtomic(lockfile: PackageLockfile): Promise<void> {
    validatePackageLockfile(lockfile);
    await atomicJsonWrite(this.#lockfilePath, lockfile);
  }

  async readReceipt(idempotencyKey: string): Promise<PackageOperationReceipt | undefined> {
    return (await this.#readReceipts()).receipts[idempotencyKey];
  }

  async writeReceipt(receipt: PackageOperationReceipt): Promise<void> {
    const current = await this.#readReceipts();
    const existing = current.receipts[receipt.idempotencyKey];
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(receipt)) {
      throw new Error("package operation receipt idempotency conflict");
    }
    await atomicJsonWrite(this.#receiptsPath, {
      schemaVersion: "1.0",
      receipts: { ...current.receipts, [receipt.idempotencyKey]: receipt },
    } satisfies ReceiptStore);
  }

  async stage(
    operationId: string,
    verified: VerifiedPackage,
    resolvedPackage: ResolvedPackage,
  ): Promise<StagedPackage> {
    const stagingRoot = this.#insideCache("staging", safeSegment(operationId));
    const packageRoot = this.#insideCache(
      "packages",
      safeSegment(verified.manifest.id),
      safeSegment(verified.manifest.version),
      verified.packageDigest.slice("sha256:".length),
    );
    await rm(stagingRoot, { recursive: true, force: true });
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    let created = false;
    try {
      await writeFile(
        containedFile(stagingRoot, "capybara.package.json"),
        resolvedPackage.manifestBytes,
        { flag: "wx", mode: 0o600 },
      );
      for (const file of resolvedPackage.files) {
        const target = containedFile(stagingRoot, file.path);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, file.bytes, { flag: "wx", mode: 0o600 });
      }
      await verifyCacheRoot(stagingRoot, verified);
      try {
        await access(packageRoot);
        await verifyCacheRoot(packageRoot, verified);
        await rm(stagingRoot, { recursive: true, force: true });
      } catch (error) {
        if (!isMissing(error)) throw error;
        await mkdir(dirname(packageRoot), { recursive: true, mode: 0o700 });
        await rename(stagingRoot, packageRoot);
        created = true;
      }
      return Object.freeze({
        operationId,
        packageId: verified.manifest.id,
        root: packageRoot,
        created,
      });
    } catch (error) {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async activate(input: PackageActivation): Promise<void> {
    await this.#activationHost.activate(input);
  }

  async healthCheck(input: PackageActivation): Promise<boolean> {
    return await this.#activationHost.healthCheck(input);
  }

  async rollback(packageId: string, previous: PackageLockEntry | undefined): Promise<void> {
    await this.#activationHost.rollback(packageId, previous);
  }

  async cleanup(stage: StagedPackage): Promise<void> {
    if (stage.created !== true) return;
    const root = resolve(stage.root);
    assertWithin(this.#insideCache("packages"), root);
    await rm(root, { recursive: true, force: true });
  }

  async #readReceipts(): Promise<ReceiptStore> {
    try {
      const parsed = JSON.parse(await readFile(this.#receiptsPath, "utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("package receipt store is malformed");
      }
      const root = parsed as Record<string, unknown>;
      if (root.schemaVersion !== "1.0" || typeof root.receipts !== "object" || root.receipts === null) {
        throw new Error("package receipt store is malformed");
      }
      return {
        schemaVersion: "1.0",
        receipts: root.receipts as Record<string, PackageOperationReceipt>,
      };
    } catch (error) {
      if (isMissing(error)) return { schemaVersion: "1.0", receipts: {} };
      throw error;
    }
  }

  #insideCache(...segments: readonly string[]): string {
    const path = resolve(this.#cacheRoot, ...segments);
    assertWithin(this.#cacheRoot, path);
    return path;
  }
}

async function verifyCacheRoot(root: string, verified: VerifiedPackage): Promise<void> {
  const manifestPath = containedFile(root, "capybara.package.json");
  const manifestMetadata = await stat(manifestPath);
  if (!manifestMetadata.isFile()) throw new Error("cached package manifest is not a file");
  const manifestDigest = "sha256:" + createHash("sha256")
    .update(await readFile(manifestPath))
    .digest("hex");
  if (manifestDigest !== verified.manifestDigest) {
    throw new Error("cached package manifest digest mismatch");
  }
  for (const [path, expected] of Object.entries(verified.fileDigests)) {
    const target = containedFile(root, path);
    const metadata = await stat(target);
    if (!metadata.isFile()) throw new Error("cached package contains a non-file");
    const actual = "sha256:" + createHash("sha256")
      .update(await readFile(target))
      .digest("hex");
    if (actual !== expected) {
      throw new Error("cached package digest mismatch for " + path);
    }
  }
}

function containedFile(root: string, packagePath: string): string {
  const path = resolve(root, ...packagePath.split("/"));
  assertWithin(root, path);
  return path;
}

function assertWithin(root: string, path: string): void {
  const traversal = relative(resolve(root), resolve(path));
  if (
    traversal === ".."
    || traversal.startsWith(".." + sep)
    || isAbsolute(traversal)
  ) {
    throw new Error("package store path escaped its cache root");
  }
}

function safeSegment(value: string): string {
  const segment = value.replaceAll("/", "__").replaceAll("\\", "__");
  if (!/^[A-Za-z0-9_.-]+$/u.test(segment)) {
    throw new Error("package cache segment is invalid");
  }
  return segment;
}

async function atomicJsonWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + ".tmp-" + process.pid + "-" + randomUUID();
  let renamed = false;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
    renamed = true;
  } finally {
    if (!renamed) await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT";
}
