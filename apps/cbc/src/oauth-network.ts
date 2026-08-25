/**
 * Hardened HTTPS requests for OAuth discovery and token endpoints.
 *
 * OAuth metadata is attacker-controlled until it has been validated. Requests made
 * while discovering it therefore pin a DNS result that was checked to be globally
 * routable, refuse cross-origin redirects, and cap both time and response size.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";

export const OAUTH_REQUEST_TIMEOUT_MS = 15_000;
export const OAUTH_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;

export type OAuthNetworkErrorKind =
  | "policy"
  | "dns"
  | "timeout"
  | "network"
  | "response-too-large"
  | "redirect";

export class OAuthNetworkError extends Error {
  readonly kind: OAuthNetworkErrorKind;
  readonly transient: boolean;
  /** Stable socket error code when the runtime supplied one. */
  readonly code?: string;
  /** The validated address used for the failed connection attempt. */
  readonly address?: string;

  constructor(
    kind: OAuthNetworkErrorKind,
    message: string,
    transient = false,
    details: { readonly code?: string; readonly address?: string } = {},
  ) {
    super(message);
    this.name = "OAuthNetworkError";
    this.kind = kind;
    this.transient = transient;
    if (details.code !== undefined) this.code = details.code;
    if (details.address !== undefined) this.address = details.address;
  }
}

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type OAuthResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export interface SafeOAuthRequestOptions {
  readonly method?: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly resolver?: OAuthResolver;
  readonly requester?: OAuthPinnedRequester;
}

export interface SafeOAuthResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function ipv4Octets(address: string): number[] | undefined {
  if (isIP(address) !== 4) return undefined;
  const values = address.split(".").map(Number);
  return values.length === 4 && values.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
    ? values
    : undefined;
}

function ipv6Words(address: string): number[] | undefined {
  if (isIP(address) !== 6) return undefined;

  let expanded = address.toLowerCase();
  const lastColon = expanded.lastIndexOf(":");
  const dottedTail = lastColon >= 0 ? expanded.slice(lastColon + 1) : expanded;
  const embeddedV4 = ipv4Octets(dottedTail);
  if (embeddedV4 !== undefined) {
    const [a = 0, b = 0, c = 0, d = 0] = embeddedV4;
    expanded = `${expanded.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const compression = expanded.indexOf("::");
  if (compression !== -1 && compression !== expanded.lastIndexOf("::")) return undefined;
  const left = (compression === -1 ? expanded : expanded.slice(0, compression))
    .split(":")
    .filter((part) => part.length > 0);
  const right = (compression === -1 ? "" : expanded.slice(compression + 2))
    .split(":")
    .filter((part) => part.length > 0);
  const missing = compression === -1 ? 0 : 8 - left.length - right.length;
  if (compression !== -1 && missing < 1) return undefined;
  const parts = compression === -1 ? left : [...left, ...Array(missing).fill("0"), ...right];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) {
    return undefined;
  }
  return parts.map((part) => Number.parseInt(part, 16));
}

/** True only for addresses CBC is willing to contact during OAuth. */
export function isPublicOAuthAddress(rawAddress: string): boolean {
  const address = stripIpv6Brackets(rawAddress).split("%")[0] ?? "";
  const v4 = ipv4Octets(address);
  if (v4 !== undefined) {
    const [a = 0, b = 0, c = 0] = v4;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && ((b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) return false;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }

  const words = ipv6Words(address);
  if (words === undefined) return false;
  const first = words[0] ?? 0;
  const second = words[1] ?? 0;
  const third = words[2] ?? 0;
  const sixth = words[5] ?? 0;
  if (words.slice(0, 6).every((word) => word === 0)) return false;
  if (words.slice(0, 5).every((word) => word === 0) && sixth === 0xffff) {
    const mapped = `${words[6]! >>> 8}.${words[6]! & 0xff}.${words[7]! >>> 8}.${words[7]! & 0xff}`;
    return isPublicOAuthAddress(mapped);
  }
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) {
    return false;
  }
  if (first === 0x0064 && second === 0xff9b) return false;
  if (first === 0x2002) return false;
  if (first === 0x2001) {
    if (second === 0x0000 || second === 0x0db8 || (second === 0x0002 && third === 0)) return false;
    if ((second & 0xfff0) === 0x0010 || (second & 0xfff0) === 0x0020) return false;
  }
  if (first === 0x3fff && (second & 0xf000) === 0) return false;
  return first >= 0x2000 && first <= 0x3fff;
}

/** Parse an OAuth endpoint and reject schemes/names that must never be contacted. */
export function validateOAuthEndpoint(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OAuthNetworkError("policy", `OAuth endpoint is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "https:") {
    throw new OAuthNetworkError("policy", `OAuth endpoint must use HTTPS: ${url.toString()}`);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new OAuthNetworkError("policy", "OAuth endpoints may not contain user information");
  }
  if (url.hash.length > 0) {
    throw new OAuthNetworkError("policy", "OAuth endpoints may not contain fragments");
  }

  const hostname = stripIpv6Brackets(url.hostname).toLowerCase().replace(/\.$/, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa") ||
    hostname === "metadata.google.internal"
  ) {
    throw new OAuthNetworkError("policy", `OAuth endpoint uses a local hostname: ${hostname}`);
  }
  if (isIP(hostname) !== 0 && !isPublicOAuthAddress(hostname)) {
    throw new OAuthNetworkError("policy", `OAuth endpoint resolves to a non-public address: ${hostname}`);
  }
  return url;
}

async function defaultResolver(hostname: string): Promise<readonly ResolvedAddress[]> {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((entry) => ({ address: entry.address, family: entry.family as 4 | 6 }));
}

async function resolveAndValidate(
  url: URL,
  resolver: OAuthResolver,
): Promise<readonly ResolvedAddress[]> {
  const hostname = stripIpv6Brackets(url.hostname);
  if (isIP(hostname) !== 0) {
    return [{ address: hostname, family: isIP(hostname) as 4 | 6 }];
  }

  let addresses: readonly ResolvedAddress[];
  try {
    addresses = await resolver(hostname);
  } catch (error) {
    throw new OAuthNetworkError(
      "dns",
      `could not resolve OAuth endpoint '${hostname}': ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
  if (addresses.length === 0) {
    throw new OAuthNetworkError("dns", `OAuth endpoint '${hostname}' resolved to no addresses`, true);
  }
  const unique = new Map<string, ResolvedAddress>();
  for (const entry of addresses) {
    if ((entry.family !== 4 && entry.family !== 6) || !isPublicOAuthAddress(entry.address)) {
      throw new OAuthNetworkError(
        "policy",
        `OAuth endpoint '${hostname}' resolved to a non-public address (${entry.address})`,
      );
    }
    unique.set(`${entry.family}:${entry.address}`, entry);
  }
  return [...unique.values()];
}

export interface OAuthRawResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export type OAuthPinnedRequester = (
  url: URL,
  address: ResolvedAddress,
  options: SafeOAuthRequestOptions,
) => Promise<OAuthRawResponse>;

/**
 * Build an HTTPS request that dials only the validated address while preserving
 * the OAuth origin for HTTP routing and certificate verification.
 *
 * A custom `lookup` callback would normally provide DNS pinning, but Bun 1.3 on
 * Windows can report `ECONNREFUSED` for that path even when the same address is
 * reachable. Dialling the IP directly avoids a second DNS lookup and works in both
 * Node and Bun. The original hostname remains authoritative through SNI and Host.
 */
export function createPinnedRequestOptions(
  url: URL,
  address: ResolvedAddress,
  options: SafeOAuthRequestOptions,
): RequestOptions {
  const originHostname = stripIpv6Brackets(url.hostname);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (name.toLowerCase() !== "host") headers[name] = value;
  }
  headers.host = url.host;

  return {
    protocol: "https:",
    hostname: stripIpv6Brackets(address.address),
    port: url.port.length > 0 ? Number(url.port) : 443,
    path: `${url.pathname}${url.search}`,
    method: options.method ?? "GET",
    headers,
    ...(isIP(originHostname) === 0 ? { servername: originHostname } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  };
}

async function requestPinned(
  url: URL,
  address: ResolvedAddress,
  options: SafeOAuthRequestOptions,
): Promise<OAuthRawResponse> {
  const timeoutMs = options.timeoutMs ?? OAUTH_REQUEST_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? OAUTH_MAX_RESPONSE_BYTES;
  return await new Promise<OAuthRawResponse>((resolve, reject) => {
    let timedOut = false;
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      if (error instanceof OAuthNetworkError) reject(error);
      else if (timedOut) reject(new OAuthNetworkError("timeout", `OAuth request to ${url.origin} timed out`, true));
      else if (options.signal?.aborted === true) reject(new OAuthNetworkError("network", "OAuth request was cancelled", true));
      else {
        const code = networkErrorCode(error);
        reject(
          new OAuthNetworkError(
            "network",
            `OAuth request to ${url.origin} failed: ${error instanceof Error ? error.message : String(error)}`,
            true,
            {
              ...(code !== undefined ? { code } : {}),
              address: address.address,
            },
          ),
        );
      }
    };

    const requestOptions = createPinnedRequestOptions(url, address, options);

    const request = httpsRequest(requestOptions, (response) => {
      const chunks: Uint8Array[] = [];
      let received = 0;
      const declared = Number(response.headers["content-length"] ?? 0);
      if (Number.isFinite(declared) && declared > maxBytes) {
        request.destroy(new OAuthNetworkError("response-too-large", `OAuth response exceeded ${maxBytes} bytes`));
        return;
      }
      response.on("data", (chunk: Uint8Array | string) => {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
        received += bytes.byteLength;
        if (received > maxBytes) {
          request.destroy(new OAuthNetworkError("response-too-large", `OAuth response exceeded ${maxBytes} bytes`));
          return;
        }
        chunks.push(bytes);
      });
      response.on("error", fail);
      response.on("end", () => {
        if (settled) return;
        settled = true;
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(response.headers)) {
          if (value !== undefined) headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
        }
        resolve({
          status: response.statusCode ?? 0,
          headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    request.setTimeout(timeoutMs, () => {
      timedOut = true;
      request.destroy();
    });
    request.on("error", fail);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

/**
 * Connection errors that prove the request never reached an HTTP peer.
 *
 * OAuth authorization codes and rotating refresh tokens must not be replayed after
 * an ambiguous failure. These codes are safe because the socket could not connect,
 * so Node/Bun could not have transmitted the queued request body.
 */
const ADDRESS_FALLBACK_CODES = new Set([
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EADDRNOTAVAIL",
  "EAFNOSUPPORT",
]);

function networkErrorCode(error: unknown, depth = 0): string | undefined {
  if (depth > 2 || typeof error !== "object" || error === null) return undefined;
  const record = error as { readonly code?: unknown; readonly cause?: unknown; readonly message?: unknown };
  if (typeof record.code === "string" && record.code.length > 0) return record.code.toUpperCase();
  if (record.cause !== undefined && record.cause !== error) {
    const causeCode = networkErrorCode(record.cause, depth + 1);
    if (causeCode !== undefined) return causeCode;
  }
  if (typeof record.message !== "string") return undefined;
  return record.message
    .match(/\b(E(?:CONNREFUSED|NETUNREACH|HOSTUNREACH|ADDRNOTAVAIL|AFNOSUPPORT))\b/i)?.[1]
    ?.toUpperCase();
}

function mayTryNextAddress(error: unknown): boolean {
  if (error instanceof OAuthNetworkError && error.kind !== "network") return false;
  const code = networkErrorCode(error);
  return code !== undefined && ADDRESS_FALLBACK_CODES.has(code);
}

async function requestValidatedAddresses(
  url: URL,
  addresses: readonly ResolvedAddress[],
  options: SafeOAuthRequestOptions,
  requester: OAuthPinnedRequester,
): Promise<OAuthRawResponse> {
  const timeoutMs = options.timeoutMs ?? OAUTH_REQUEST_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  for (let index = 0; index < addresses.length; index += 1) {
    if (options.signal?.aborted === true) {
      throw new OAuthNetworkError("network", "OAuth request was cancelled", true);
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new OAuthNetworkError("timeout", `OAuth request to ${url.origin} timed out`, true);
    }

    const address = addresses[index] as ResolvedAddress;
    try {
      return await requester(url, address, { ...options, timeoutMs: remainingMs });
    } catch (error) {
      const hasAnotherAddress = index + 1 < addresses.length;
      if (!hasAnotherAddress || !mayTryNextAddress(error)) throw error;
    }
  }

  // Resolution guarantees a non-empty array. Keep a defensive terminal error in
  // case an injected resolver or future refactor violates that invariant.
  throw new OAuthNetworkError("dns", `OAuth endpoint '${url.hostname}' resolved to no addresses`, true);
}

function redirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** Perform an OAuth request without allowing SSRF, token redirects, or unbounded I/O. */
export async function safeOAuthRequest(
  rawUrl: string,
  options: SafeOAuthRequestOptions = {},
): Promise<SafeOAuthResponse> {
  const resolver = options.resolver ?? defaultResolver;
  const requester = options.requester ?? requestPinned;
  let current = validateOAuthEndpoint(rawUrl);
  const originalOrigin = current.origin;
  let method = options.method ?? "GET";
  let body = options.body;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const addresses = await resolveAndValidate(current, resolver);
    const response = await requestValidatedAddresses(
      current,
      addresses,
      {
        ...options,
        method,
        ...(body !== undefined ? { body } : {}),
      },
      requester,
    );
    const maxBytes = options.maxResponseBytes ?? OAUTH_MAX_RESPONSE_BYTES;
    if (Buffer.byteLength(response.body, "utf8") > maxBytes) {
      throw new OAuthNetworkError("response-too-large", `OAuth response exceeded ${maxBytes} bytes`);
    }
    if (!redirectStatus(response.status)) {
      return {
        status: response.status,
        ok: response.status >= 200 && response.status < 300,
        url: current.toString(),
        headers: response.headers,
        body: response.body,
      };
    }
    if (redirects === MAX_REDIRECTS) {
      throw new OAuthNetworkError("redirect", "OAuth endpoint redirected too many times");
    }
    const location = response.headers.location;
    if (location === undefined) {
      throw new OAuthNetworkError("redirect", "OAuth endpoint returned a redirect without Location");
    }
    const next = validateOAuthEndpoint(new URL(location, current).toString());
    if (next.origin !== originalOrigin) {
      throw new OAuthNetworkError(
        "redirect",
        `OAuth redirect from ${originalOrigin} to ${next.origin} was refused`,
      );
    }
    if (response.status === 303) {
      method = "GET";
      body = undefined;
    }
    current = next;
  }

  throw new OAuthNetworkError("redirect", "OAuth endpoint redirected too many times");
}

