/**
 * In-process App Protocol transport. TUI and headless use the same client as
 * the SDK, even when the daemon is not a separate process.
 */

import {
  APP_PROTOCOL_VERSION,
  type AppInitializeParams,
} from "@cbc/app-protocol";
import { AppServer, type AppJsonRpcRequest, type AppJsonRpcResponse } from "@cbc/app-server";
import { CapybaraClient, type JsonRpcMessage, type JsonRpcTransport } from "@cbc/sdk";

export function createInProcessAppTransport(app: AppServer): JsonRpcTransport {
  let connectionId: string | undefined;
  const handlers = new Set<(message: JsonRpcMessage) => void>();
  return {
    async send(message: JsonRpcMessage): Promise<void> {
      if (!("method" in message) || !("id" in message)) return;
      const request = message as AppJsonRpcRequest;
      const response: AppJsonRpcResponse = await app.dispatch(
        request.method === "server.initialize" ? undefined : connectionId,
        request,
      );
      if ("result" in response && typeof response.result === "object" && response.result !== null) {
        const connection = (response.result as { connectionId?: unknown }).connectionId;
        if (typeof connection === "string") connectionId = connection;
      }
      for (const handler of handlers) handler(response);
    },
    subscribe(handler: (message: JsonRpcMessage) => void): () => void {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    close(): void {
      if (connectionId !== undefined) app.closeConnection(connectionId);
      handlers.clear();
    },
  };
}

export async function connectEmbeddedAppClient(input: {
  readonly app: AppServer;
  readonly clientId: string;
  readonly kind: AppInitializeParams["client"]["kind"];
  readonly version: string;
}): Promise<CapybaraClient> {
  return await CapybaraClient.connect({
    transport: "stdio",
    client: {
      id: input.clientId,
      name: "capy",
      version: input.version,
      kind: input.kind,
    },
    createTransport: () => createInProcessAppTransport(input.app),
  });
}

export { APP_PROTOCOL_VERSION };

export async function submitTurnOverApp(input: {
  readonly client: CapybaraClient;
  readonly sessionId: string;
  readonly prompt: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly answer: string;
  readonly status: string;
  readonly report: unknown;
  readonly presentation?: unknown;
}> {
  const session = input.client.session(input.sessionId);
  const onAbort = (): void => {
    void input.client.request("turn.cancel", {
      command: {
        schemaVersion: "1.0",
        commandId: "cmd_cancel_" + crypto.randomUUID().replaceAll("-", ""),
        idempotencyKey: "idem_cancel_" + crypto.randomUUID().replaceAll("-", ""),
        correlationId: "cor_cancel_" + crypto.randomUUID().replaceAll("-", ""),
        clientId: input.client.clientId,
        sessionId: input.sessionId,
        issuedAt: new Date().toISOString(),
        payload: {},
      },
    }).catch(() => undefined);
  };
  if (input.signal.aborted) onAbort();
  else input.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const handle = await session.submit(input.prompt);
    const result = handle.receipt.result as {
      readonly answer?: string;
      readonly status?: string;
      readonly report?: unknown;
      readonly presentation?: unknown;
    } | undefined;
    return {
      answer: typeof result?.answer === "string" ? result.answer : "",
      status: typeof result?.status === "string" ? result.status : handle.receipt.status,
      report: result?.report,
      ...(result?.presentation === undefined ? {} : { presentation: result.presentation }),
    };
  } finally {
    input.signal.removeEventListener("abort", onAbort);
  }
}
