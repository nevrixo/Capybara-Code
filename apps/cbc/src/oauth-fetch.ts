/** Fetch-compatible adapter over the pinned, bounded OAuth transport. */

import type { FetchLike } from "@cbc/provider-openai";

import { OAuthNetworkError, safeOAuthRequest } from "./oauth-network.ts";

export const safeOAuthFetch: FetchLike = async (url, init = {}) => {
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "POST") {
    throw new OAuthNetworkError("policy", `OAuth requests may not use ${method}`);
  }

  let body: string | undefined;
  if (init.body !== undefined && init.body !== null) {
    if (typeof init.body !== "string") {
      throw new OAuthNetworkError("policy", "OAuth request bodies must be encoded strings");
    }
    body = init.body;
  }

  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, name) => {
    headers[name] = value;
  });

  const response = await safeOAuthRequest(url, {
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
    ...(init.signal !== undefined && init.signal !== null ? { signal: init.signal } : {}),
  });
  const bodyAllowed = response.status !== 204 && response.status !== 205 && response.status !== 304;
  return new Response(bodyAllowed ? response.body : null, {
    status: response.status,
    headers: response.headers,
  });
};
