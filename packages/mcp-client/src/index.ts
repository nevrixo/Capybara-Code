/**
 * `@cbc/mcp-client` — the MCP client: dual-era protocol negotiation, stdio and
 * Streamable HTTP transports, the capability catalog, the permission model, OAuth,
 * result normalization (PRD §17).
 *
 * §17.1 sets the posture this package implements: CBC is the client. The model
 * never reaches a server directly — it asks, and CBC decides whether, how, and with
 * what authority the call happens.
 */

export * from "./protocol.ts";
export * from "./transport.ts";
export * from "./catalog.ts";
export * from "./results.ts";
export * from "./permission.ts";
export * from "./oauth.ts";
export * from "./client.ts";
