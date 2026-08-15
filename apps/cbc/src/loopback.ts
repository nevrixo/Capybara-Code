/**
 * Loopback redirect listener — PRD §7.3, §9.5, §9.6, §17.9.
 *
 * Two authorization flows need to receive a redirect: MCP server authorization
 * (§17.9) and OpenAI account login (§9.5). Both are restricted to a *loopback*
 * redirect, so both need exactly the same listener, and there is one of them here
 * rather than one per flow. A weakness in this file would otherwise have to be found
 * twice.
 *
 * Three properties matter and are enforced here rather than left to the caller:
 *
 *   - The socket binds `127.0.0.1` explicitly, never `0.0.0.0`. An authorization code
 *     delivered from off-host is not a redirect, it is an injection.
 *   - Exactly one path answers. Anything else is a 404, so a stray request cannot
 *     resolve the wait with an empty parameter set.
 *   - The wait always terminates. An authorization that is never completed has to
 *     stop being waited on, because §7.3 requires the pending state to be discarded
 *     when the user walks away.
 */

import { CliError, EXIT } from "./exit.ts";
import {
  renderLoopbackPage,
  type LoopbackPageOptions,
} from "./loopback-page.ts";
export { renderLoopbackPage } from "./loopback-page.ts";
export type { LoopbackPageOptions, RenderLoopbackPageOptions } from "./loopback-page.ts";

/** How long a loopback wait lasts before it gives up (§17.9's pending lifetime). */
export const LOOPBACK_TIMEOUT_MS = 10 * 60 * 1000;

export type LoopbackOutcome =
  | { readonly kind: "params"; readonly params: Record<string, string> }
  | { readonly kind: "timeout" }
  | { readonly kind: "cancelled" };

export interface LoopbackWaitOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface LoopbackCapture {
  /** The `redirect_uri` to send in the authorization request. */
  readonly redirectUri: string;
  readonly port: number;
  wait(options?: LoopbackWaitOptions): Promise<LoopbackOutcome>;
  close(): void;
}

export interface StartLoopbackOptions {
  /** Fixed port required by a registered OAuth redirect; defaults to ephemeral. */
  readonly port?: number;
  /** Hostname written into redirect_uri while the socket stays bound to loopback. */
  readonly redirectHost?: "127.0.0.1" | "localhost";
  /** Redirect path. Defaults to `/callback`. */
  readonly path?: string;
  /** Legacy success copy shown in the browser once the redirect arrives. */
  readonly message?: string;
  /** Safe, text-only copy overrides for the generated callback page. */
  readonly page?: LoopbackPageOptions;
}

/**
 * Bind an ephemeral loopback port and capture one redirect.
 *
 * The port is `0` so the OS assigns it: a fixed port would collide with a second
 * `capy` and, worse, would let an unrelated local process pre-bind the address the
 * authorization server has been told to redirect to.
 */
export function startLoopback(options: StartLoopbackOptions = {}): LoopbackCapture {
  const path = options.path ?? "/callback";
  const message =
    options.message ?? "Capybara Code received the authorization response. You can close this tab.";

  const serve = (globalThis as { Bun?: { serve?: unknown } }).Bun?.serve;
  if (typeof serve !== "function") {
    throw new CliError(EXIT.internal, "no HTTP server is available for the loopback redirect", [
      "An authorization redirect requires the Bun runtime.",
    ]);
  }

  let resolveParams: (params: Record<string, string>) => void = () => undefined;
  const received = new Promise<Record<string, string>>((resolve) => {
    resolveParams = resolve;
  });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    fetch(request: Request): Response {
      const url = new URL(request.url);
      if (url.pathname !== path) return new Response("not found", { status: 404 });
      const params: Record<string, string> = {};
      for (const [key, value] of url.searchParams) params[key] = value;
      resolveParams(params);
      const status =
        url.searchParams.has("error") || url.searchParams.has("error_description")
          ? "error"
          : "success";
      return new Response(
        renderLoopbackPage({
          status,
          message,
          ...(options.page !== undefined ? { page: options.page } : {}),
        }),
        {
          status: 200,
          headers: {
            "cache-control": "no-store",
            "content-security-policy":
              "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            "content-type": "text/html; charset=utf-8",
            "referrer-policy": "no-referrer",
            "x-content-type-options": "nosniff",
          },
        },
      );
    },
  });

  const port = server.port;
  if (port === undefined) {
    // Without a port there is no redirect URI to send, and continuing would produce
    // an authorization request that can never be answered.
    server.stop(true);
    throw new CliError(EXIT.internal, "the loopback listener did not report a port");
  }

  return {
    redirectUri: `http://${options.redirectHost ?? "127.0.0.1"}:${port}${path}`,
    port,
    async wait(waitOptions: LoopbackWaitOptions = {}): Promise<LoopbackOutcome> {
      const timeoutMs = waitOptions.timeoutMs ?? LOOPBACK_TIMEOUT_MS;
      const signal = waitOptions.signal;
      if (signal?.aborted === true) return { kind: "cancelled" };

      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      try {
        const outcome = await Promise.race<LoopbackOutcome>([
          received.then((params) => ({ kind: "params", params }) as const),
          new Promise<LoopbackOutcome>((resolve) => {
            timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
          }),
          new Promise<LoopbackOutcome>((resolve) => {
            if (signal === undefined) return;
            onAbort = () => resolve({ kind: "cancelled" });
            signal.addEventListener("abort", onAbort, { once: true });
          }),
        ]);
        return outcome;
      } finally {
        // The timer is cleared explicitly: an outstanding one keeps the process
        // alive for up to ten minutes after the command has finished.
        if (timer !== undefined) clearTimeout(timer);
        if (onAbort !== undefined && signal !== undefined) {
          signal.removeEventListener("abort", onAbort);
        }
      }
    },
    close(): void {
      server.stop(true);
    },
  };
}
