import { describe, expect, test } from "bun:test";
import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";

import { canonicalJson } from "@cbc/app-protocol";
import { canonicalPluginPackageDigest } from "@cbc/plugin-sdk";

import {
  RegistryPackageResolver,
  SignedStaticRegistryTransport,
  verifyResolvedPackage,
  type CapybaraPackageManifest,
} from "../src/index.ts";

const encoder = new TextEncoder();

function digest(bytes: Uint8Array): string {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

function signedFixture(overrides: {
  readonly expiresAt?: string;
  readonly withdrawn?: boolean;
  readonly artifact?: string;
  readonly tamperIndexSignature?: boolean;
  readonly tamperFile?: boolean;
} = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyId = "registry-root-2026";
  const skillPath = "skills/quality/SKILL.md";
  const skillBytes = encoder.encode("# Quality\n");
  const fileDigests = { [skillPath]: digest(skillBytes) };
  const manifestBody = {
    schemaVersion: "1.0",
    id: "acme/typescript-quality",
    version: "1.2.0",
    capybara: ">=0.1.0",
    contents: { skills: [skillPath] },
    permissions: {},
    integrity: {
      files: fileDigests,
      packageDigest: canonicalPluginPackageDigest(fileDigests),
    },
  } satisfies Omit<CapybaraPackageManifest, "signature">;
  const manifest: CapybaraPackageManifest = {
    ...manifestBody,
    signature: {
      keyId,
      algorithm: "ed25519",
      value: sign(
        null,
        Buffer.from(canonicalJson(manifestBody)),
        privateKey,
      ).toString("base64"),
    },
  };
  const manifestBytes = encoder.encode(JSON.stringify(manifest));
  const indexBody = {
    schemaVersion: "1.0",
    generatedAt: "2026-08-30T00:00:00.000Z",
    expiresAt: overrides.expiresAt ?? "2026-09-30T00:00:00.000Z",
    packages: [{
      id: manifest.id,
      description: "TypeScript quality checks",
      keywords: ["typescript", "quality"],
      latest: manifest.version,
      versions: [{
        version: manifest.version,
        artifact: overrides.artifact ?? "packages/acme/typescript-quality/1.2.0.json",
        manifestDigest: digest(manifestBytes),
        packageDigest: manifest.integrity.packageDigest,
        keyId,
        withdrawn: overrides.withdrawn ?? false,
      }],
    }],
    revokedKeyIds: [],
  };
  let indexSignature = sign(
    null,
    Buffer.from(canonicalJson(indexBody)),
    privateKey,
  ).toString("base64");
  if (overrides.tamperIndexSignature) {
    indexSignature = Buffer.alloc(64, 7).toString("base64");
  }
  const index = {
    ...indexBody,
    signature: { keyId, algorithm: "ed25519", value: indexSignature },
  };
  const artifact = {
    schemaVersion: "1.0",
    manifest: Buffer.from(manifestBytes).toString("base64"),
    files: [{
      path: skillPath,
      content: Buffer.from(
        overrides.tamperFile ? encoder.encode("# Tampered\n") : skillBytes,
      ).toString("base64"),
    }],
  };
  const responses = new Map<string, unknown>([
    ["https://registry.example/v1/index.json", index],
    [
      "https://registry.example/v1/packages/acme/typescript-quality/1.2.0.json",
      artifact,
    ],
  ]);
  const requests: string[] = [];
  const transport = new SignedStaticRegistryTransport({
    baseUrl: "https://registry.example/v1/",
    pinnedKeys: {
      [keyId]: publicKey.export({ format: "pem", type: "spki" }).toString(),
    },
    now: () => Date.parse("2026-08-30T12:00:00.000Z"),
    fetch: async (url) => {
      requests.push(url);
      const body = responses.get(url);
      return body === undefined
        ? new Response("not found", { status: 404 })
        : Response.json(body);
    },
  });
  return { transport, requests };
}

describe("SignedStaticRegistryTransport", () => {
  test("verifies pinned index and manifest signatures before resolving bytes", async () => {
    const { transport, requests } = signedFixture();
    const results = await transport.search("typescript");
    expect(results.map((item) => item.id)).toEqual(["acme/typescript-quality"]);
    const resolver = new RegistryPackageResolver(transport);
    const resolved = await resolver.resolve("registry:acme/typescript-quality@1.2.0");
    const verified = verifyResolvedPackage(resolved);
    expect(verified.signatureVerified).toBe(true);
    expect(verified.manifest.version).toBe("1.2.0");
    expect(requests).toEqual([
      "https://registry.example/v1/index.json",
      "https://registry.example/v1/packages/acme/typescript-quality/1.2.0.json",
    ]);
  });

  test("rejects a forged index, expired metadata, withdrawal, and URL escape", async () => {
    await expect(signedFixture({ tamperIndexSignature: true }).transport.search("quality"))
      .rejects.toThrow(/signature verification failed/);
    await expect(signedFixture({
      expiresAt: "2026-08-30T11:59:59.000Z",
    }).transport.search("quality")).rejects.toThrow(/expired/);
    await expect(signedFixture({ withdrawn: true }).transport.fetch(
      "registry:acme/typescript-quality",
    )).rejects.toThrow(/withdrawn/);
    await expect(signedFixture({
      artifact: "https://evil.example/package.json",
    }).transport.fetch("registry:acme/typescript-quality")).rejects.toThrow(/escaped/);
  });

  test("detects a one-byte package payload tamper and refuses offline network", async () => {
    const { transport } = signedFixture({ tamperFile: true });
    await expect(transport.fetch("registry:acme/typescript-quality"))
      .rejects.toThrow(/digest/);
    await expect(transport.fetch("registry:acme/typescript-quality", { offline: true }))
      .rejects.toThrow(/offline/);
  });
});
