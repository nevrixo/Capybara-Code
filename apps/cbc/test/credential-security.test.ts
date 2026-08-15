import { describe, expect, test } from "bun:test";

import type { McpCredentialRecord } from "@cbc/mcp-client";

import {
  OPENAI_ACCOUNT_REFRESH,
  OPENAI_ACCOUNT_TOKEN,
  accountRecordPath,
  replaceAccountTokenSet,
  resolveAccountCredential,
  writeAccountRecord,
  type CredentialStore,
} from "../src/credentials.ts";
import {
  recordFromToken,
  type AccountClientRegistration,
  type AccountTokenRecord,
} from "../src/account-login.ts";
import type { CbcPaths, Host, HostFs } from "../src/host.ts";
import {
  mcpCredentialRecordPath,
  replaceMcpTokenSet,
  resolveMcpAuthorization,
  writeMcpCredentialRecord,
} from "../src/mcp-credentials.ts";
import { OAuthNetworkError } from "../src/oauth-network.ts";

class MemoryFs implements HostFs {
  readonly files = new Map<string, string>();
  failNextAtomicWrite = false;

  async read(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async atomicWrite(path: string, content: string): Promise<void> {
    if (this.failNextAtomicWrite) {
      this.failNextAtomicWrite = false;
      throw new Error("simulated metadata failure");
    }
    this.files.set(path, content);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async list(): Promise<string[]> {
    return [];
  }

  async mkdirp(): Promise<void> {}

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async isDirectory(): Promise<boolean> {
    return false;
  }
}

class MemoryCredentials implements CredentialStore {
  readonly secrets = new Map<string, string>();

  constructor(seed: Readonly<Record<string, string>> = {}) {
    for (const [account, secret] of Object.entries(seed)) this.secrets.set(account, secret);
  }

  async leaseCredential(account: string, source = "test") {
    const secret = this.secrets.get(account);
    if (secret === undefined) throw new Error(`missing credential ${account}`);
    return {
      leaseId: `lease-${account}`,
      account,
      source,
      expiresAtMs: Number.MAX_SAFE_INTEGER,
      fingerprint: `fingerprint-${secret}`,
      secret,
    };
  }

  async storeCredential(account: string, secret: string) {
    this.secrets.set(account, secret);
    return {
      account,
      backend: "memory",
      persistent: false,
      fingerprint: `fingerprint-${secret}`,
    };
  }

  async deleteCredential(account: string) {
    return { removed: this.secrets.delete(account) };
  }
}

const paths = {
  config: "/config",
  configFile: "/config/config.toml",
  data: "/data",
  cache: "/cache",
  logs: "/logs",
  share: "/share",
  runtimeBinary: "/bin/cbc-runtime",
  sessions: "/data/sessions",
  artifacts: "/data/artifacts",
  agents: "/config/agents",
  skills: "/config/skills",
  trustStore: "/data/trust.json",
  approvalStore: "/data/approvals.json",
} satisfies CbcPaths;

function hostFor(fs: MemoryFs): Pick<Host, "fs"> {
  return { fs };
}

const registration: AccountClientRegistration = {
  clientId: "capybara-code",
  issuer: "https://auth.example.com",
  authorizationEndpoint: "https://auth.example.com/authorize",
  tokenEndpoint: "https://auth.example.com/token",
  revocationEndpoint: "https://auth.example.com/revoke",
  scopes: ["openid", "offline_access"],
  audience: "https://api.example.com/v1",
  inferenceBaseUrl: "https://api.example.com/v1",
  reviews: {
    refreshAndRevocationTested: true,
    policyReviewComplete: true,
    securityReviewComplete: true,
  },
};

function accountRecord(now: number, expiresAtMs = now + 30_000): AccountTokenRecord {
  return recordFromToken({
    registration,
    response: {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAtMs,
    },
    now,
  });
}

function mcpRecord(now: number, expiresAtMs = now + 30_000): McpCredentialRecord {
  return {
    server: "tenant_mcp",
    issuer: "https://auth.example.com",
    resource: "https://mcp.example.com/mcp?tenant=a",
    scopes: ["tools:read"],
    hasRefreshToken: true,
    obtainedAtMs: now,
    expiresAtMs,
    keychainRef: "mcp:tenant_mcp",
    tokenEndpoint: "https://auth.example.com/token",
  };
}

describe("account credential transactions", () => {
  test("a metadata failure restores both secrets and the previous record", async () => {
    const fs = new MemoryFs();
    const host = hostFor(fs);
    const runtime = new MemoryCredentials({
      [OPENAI_ACCOUNT_TOKEN]: "old-access",
      [OPENAI_ACCOUNT_REFRESH]: "old-refresh",
    });
    const previous = accountRecord(1_000);
    await writeAccountRecord(host, paths, previous);
    const rawBefore = fs.files.get(accountRecordPath(paths));
    fs.failNextAtomicWrite = true;

    await expect(
      replaceAccountTokenSet({
        runtime,
        host,
        paths,
        registration,
        response: {
          accessToken: "new-access",
          refreshToken: "new-refresh",
          expiresAtMs: 100_000,
        },
        now: 2_000,
        previous,
      }),
    ).rejects.toThrow(/previous values were restored/);

    expect(runtime.secrets.get(OPENAI_ACCOUNT_TOKEN)).toBe("old-access");
    expect(runtime.secrets.get(OPENAI_ACCOUNT_REFRESH)).toBe("old-refresh");
    expect(fs.files.get(accountRecordPath(paths))).toBe(rawBefore);
  });

  test("a login response without a refresh token removes a stale refresh secret", async () => {
    const fs = new MemoryFs();
    const runtime = new MemoryCredentials({ [OPENAI_ACCOUNT_REFRESH]: "stale-refresh" });
    const result = await replaceAccountTokenSet({
      runtime,
      host: hostFor(fs),
      paths,
      registration,
      response: { accessToken: "new-access", expiresAtMs: 100_000 },
      now: 2_000,
    });

    expect(result.record.hasRefreshToken).toBe(false);
    expect(runtime.secrets.has(OPENAI_ACCOUNT_REFRESH)).toBe(false);
  });

  test("a transient refresh failure in the skew window keeps the unexpired token usable", async () => {
    const now = 10_000;
    const fs = new MemoryFs();
    const host = hostFor(fs);
    const record = accountRecord(1_000, now + 1_000);
    await writeAccountRecord(host, paths, record);
    const runtime = new MemoryCredentials({
      [OPENAI_ACCOUNT_TOKEN]: "old-access",
      [OPENAI_ACCOUNT_REFRESH]: "old-refresh",
    });

    const resolved = await resolveAccountCredential({
      runtime,
      env: {},
      host,
      paths,
      registration,
      now: () => now,
      fetchImpl: async () => {
        throw new Error("temporary outage");
      },
    });

    expect(resolved?.lease.secret).toBe("old-access");
    expect(resolved?.source).toBe("account");
  });
});

describe("MCP credential transactions and refresh", () => {
  test("a metadata failure restores MCP access, refresh, and record state", async () => {
    const fs = new MemoryFs();
    const host = hostFor(fs);
    const previous = mcpRecord(1_000);
    const runtime = new MemoryCredentials({
      [previous.keychainRef]: "old-access",
      [`${previous.keychainRef}.refresh`]: "old-refresh",
    });
    await writeMcpCredentialRecord(host, paths, previous);
    const recordPath = mcpCredentialRecordPath(paths, previous.server);
    const rawBefore = fs.files.get(recordPath);
    fs.failNextAtomicWrite = true;

    await expect(
      replaceMcpTokenSet({
        host,
        paths,
        runtime,
        record: { ...previous, obtainedAtMs: 2_000 },
        accessToken: "new-access",
        refreshToken: "new-refresh",
      }),
    ).rejects.toThrow(/previous credentials were restored/);

    expect(runtime.secrets.get(previous.keychainRef)).toBe("old-access");
    expect(runtime.secrets.get(`${previous.keychainRef}.refresh`)).toBe("old-refresh");
    expect(fs.files.get(recordPath)).toBe(rawBefore);
  });

  test("concurrent refreshes coalesce and retain an unrotated refresh token", async () => {
    const now = 10_000;
    const fs = new MemoryFs();
    const host = hostFor(fs);
    const record = mcpRecord(1_000, now + 1_000);
    const runtime = new MemoryCredentials({
      [record.keychainRef]: "old-access",
      [`${record.keychainRef}.refresh`]: "old-refresh",
    });
    await writeMcpCredentialRecord(host, paths, record);
    let requests = 0;
    const request = async (url: string) => {
      requests += 1;
      await Promise.resolve();
      return {
        status: 200,
        ok: true,
        url,
        headers: {},
        body: JSON.stringify({ access_token: "new-access", expires_in: 3_600 }),
      };
    };

    const options = {
      host,
      paths,
      runtime,
      server: record.server,
      resource: record.resource,
      now: () => now,
      request,
    };
    const [first, second] = await Promise.all([
      resolveMcpAuthorization(options),
      resolveMcpAuthorization(options),
    ]);

    expect(first).toBe("Bearer new-access");
    expect(second).toBe("Bearer new-access");
    expect(requests).toBe(1);
    expect(runtime.secrets.get(`${record.keychainRef}.refresh`)).toBe("old-refresh");
  });

  test("a transient skew-window failure falls back only while the access token is valid", async () => {
    const now = 10_000;
    const fs = new MemoryFs();
    const host = hostFor(fs);
    const record = mcpRecord(1_000, now + 1_000);
    const runtime = new MemoryCredentials({
      [record.keychainRef]: "old-access",
      [`${record.keychainRef}.refresh`]: "old-refresh",
    });
    await writeMcpCredentialRecord(host, paths, record);
    const request = async () => {
      throw new OAuthNetworkError("network", "temporary outage", true);
    };

    const authorization = await resolveMcpAuthorization({
      host,
      paths,
      runtime,
      server: record.server,
      resource: record.resource,
      now: () => now,
      request,
    });
    expect(authorization).toBe("Bearer old-access");

    await writeMcpCredentialRecord(host, paths, { ...record, expiresAtMs: now });
    await expect(
      resolveMcpAuthorization({
        host,
        paths,
        runtime,
        server: record.server,
        resource: record.resource,
        now: () => now,
        request,
      }),
    ).rejects.toThrow(/temporary outage/);
  });

  test("a tenant/resource mismatch is rejected before any token endpoint request", async () => {
    const fs = new MemoryFs();
    const host = hostFor(fs);
    const record = mcpRecord(1_000);
    const runtime = new MemoryCredentials({
      [record.keychainRef]: "old-access",
      [`${record.keychainRef}.refresh`]: "old-refresh",
    });
    await writeMcpCredentialRecord(host, paths, record);
    let requests = 0;

    await expect(
      resolveMcpAuthorization({
        host,
        paths,
        runtime,
        server: record.server,
        resource: "https://mcp.example.com/mcp?tenant=b",
        now: () => 10_000,
        request: async () => {
          requests += 1;
          throw new Error("must not be reached");
        },
      }),
    ).rejects.toThrow(/not valid/);
    expect(requests).toBe(0);
  });
});
