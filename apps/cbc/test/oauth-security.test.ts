import { describe, expect, test } from "bun:test";

import {
  OAuthNetworkError,
  createPinnedRequestOptions,
  isPublicOAuthAddress,
  safeOAuthRequest,
  validateOAuthEndpoint,
  type OAuthPinnedRequester,
  type OAuthResolver,
} from "../src/oauth-network.ts";

const publicResolver: OAuthResolver = async () => [{ address: "93.184.216.34", family: 4 }];

describe("hardened OAuth networking", () => {
  test("rejects local names and private or metadata IP literals", () => {
    for (const endpoint of [
      "http://auth.example.com/token",
      "https://localhost/token",
      "https://metadata.google.internal/token",
      "https://127.0.0.1/token",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/token",
    ]) {
      expect(() => validateOAuthEndpoint(endpoint), endpoint).toThrow(OAuthNetworkError);
    }
  });

  test("classifies special ranges without blocking adjacent public IPv4 space", () => {
    for (const address of [
      "0.0.0.1",
      "10.0.0.1",
      "100.64.0.1",
      "172.16.0.1",
      "192.168.1.1",
      "198.51.100.10",
      "203.0.113.10",
      "::1",
      "fc00::1",
      "fe80::1",
      "2001:db8::1",
      "2001:0db8:0:0:0:0:0:1",
      "2002::1",
      "64:ff9b::7f00:1",
      "::ffff:127.0.0.1",
      "3fff::1",
    ]) {
      expect(isPublicOAuthAddress(address), address).toBe(false);
    }
    expect(isPublicOAuthAddress("198.51.99.10")).toBe(true);
    expect(isPublicOAuthAddress("203.0.114.10")).toBe(true);
    expect(isPublicOAuthAddress("2606:4700:4700::1111")).toBe(true);
    expect(isPublicOAuthAddress("::ffff:8.8.8.8")).toBe(true);
  });

  test("a pinned request dials the validated IP while preserving SNI and Host", () => {
    const options = createPinnedRequestOptions(
      new URL("https://auth.example.com:8443/token?source=test"),
      { address: "93.184.216.34", family: 4 },
      {
        method: "POST",
        headers: { accept: "application/json", Host: "attacker.example" },
      },
    );

    expect(options.hostname).toBe("93.184.216.34");
    expect(options.port).toBe(8443);
    expect(options.servername).toBe("auth.example.com");
    expect(options.path).toBe("/token?source=test");
    expect(options.headers).toEqual({ accept: "application/json", host: "auth.example.com:8443" });
    expect(options.lookup).toBeUndefined();
  });

  test("rejects a hostname when any pinned DNS answer is non-public", async () => {
    let contacted = false;
    await expect(
      safeOAuthRequest("https://auth.example.com/token", {
        resolver: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "169.254.169.254", family: 4 },
        ],
        requester: async () => {
          contacted = true;
          return { status: 200, headers: {}, body: "ok" };
        },
      }),
    ).rejects.toMatchObject({ kind: "policy" });
    expect(contacted).toBe(false);
  });

  test("falls back to the next validated address after a connection refusal", async () => {
    const attempts: string[] = [];
    let resolutions = 0;
    const body = "grant_type=authorization_code&code=one-time";

    const response = await safeOAuthRequest("https://auth.example.com/token", {
      method: "POST",
      body,
      resolver: async () => {
        resolutions += 1;
        return [
          { address: "93.184.216.34", family: 4 },
          { address: "93.184.216.34", family: 4 },
          { address: "1.1.1.1", family: 4 },
        ];
      },
      requester: async (_url, address, options) => {
        attempts.push(address.address);
        expect(options.method).toBe("POST");
        expect(options.body).toBe(body);
        if (address.address === "93.184.216.34") throw new Error("ECONNREFUSED");
        return { status: 200, headers: {}, body: "ok" };
      },
    });

    expect(response.body).toBe("ok");
    expect(attempts).toEqual(["93.184.216.34", "1.1.1.1"]);
    expect(resolutions).toBe(1);
  });

  test("does not replay a token request after an ambiguous network failure", async () => {
    const attempts: string[] = [];
    const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });

    await expect(
      safeOAuthRequest("https://auth.example.com/token", {
        method: "POST",
        body: "grant_type=authorization_code&code=one-time",
        resolver: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "1.1.1.1", family: 4 },
        ],
        requester: async (_url, address) => {
          attempts.push(address.address);
          throw reset;
        },
      }),
    ).rejects.toBe(reset);

    expect(attempts).toEqual(["93.184.216.34"]);
  });

  test("refuses cross-origin redirects before sending a second request", async () => {
    let requests = 0;
    const requester: OAuthPinnedRequester = async () => {
      requests += 1;
      return {
        status: 302,
        headers: { location: "https://attacker.example/collect" },
        body: "",
      };
    };
    await expect(
      safeOAuthRequest("https://auth.example.com/token", {
        resolver: publicResolver,
        requester,
      }),
    ).rejects.toMatchObject({ kind: "redirect" });
    expect(requests).toBe(1);
  });

  test("allows bounded same-origin redirects and re-resolves each hop", async () => {
    let requests = 0;
    let resolutions = 0;
    const response = await safeOAuthRequest("https://auth.example.com/start", {
      resolver: async () => {
        resolutions += 1;
        return [{ address: "93.184.216.34", family: 4 }];
      },
      requester: async (url) => {
        requests += 1;
        return url.pathname === "/start"
          ? { status: 302, headers: { location: "/finish" }, body: "" }
          : { status: 200, headers: {}, body: "done" };
      },
    });
    expect(response.body).toBe("done");
    expect(response.url).toBe("https://auth.example.com/finish");
    expect(requests).toBe(2);
    expect(resolutions).toBe(2);
  });

  test("token endpoint failures do not echo response bodies", async () => {
    const authSource = await Bun.file(new URL("../src/commands/auth.ts", import.meta.url)).text();

    expect(authSource).not.toContain("response.text().catch(() => \"\")).slice(0, 400)");
    expect(authSource).not.toContain("tokenResponse.text().catch(() => \"\")).slice(0, 400)");
  });

  test("enforces the response cap even for an injected transport", async () => {
    await expect(
      safeOAuthRequest("https://auth.example.com/token", {
        resolver: publicResolver,
        maxResponseBytes: 4,
        requester: async () => ({ status: 200, headers: {}, body: "12345" }),
      }),
    ).rejects.toMatchObject({ kind: "response-too-large" });
  });
});
