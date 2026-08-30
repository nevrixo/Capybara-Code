import { AcpAdapter, AcpNdjsonPeer, AcpNdjsonServer } from "@cbc/acp-adapter";
import { CapybaraClient } from "@cbc/sdk";

import { CliError, EXIT } from "../exit.ts";
import { ensureSessionDaemon } from "./daemon.ts";
import { ok, type CommandContext, type CommandResult } from "./context.ts";

export async function acpCommand(context: CommandContext): Promise<CommandResult> {
  const daemon = await ensureSessionDaemon({
    context,
    enabled: true,
    autostart: true,
  });
  if (daemon.mode !== "daemon" || daemon.socketPath === undefined) {
    throw new CliError(
      EXIT.internal,
      "ACP requires the local Capybara daemon",
      ["Run capy daemon start and inspect capy integration doctor acp."],
    );
  }
  const client = await CapybaraClient.connect({
    transport: context.host.platform === "win32" ? "pipe" : "unix",
    path: daemon.socketPath,
    client: {
      name: "Capybara ACP",
      version: context.version,
      kind: "ide",
    },
  });
  const write = async (line: string): Promise<void> => {
    context.host.io.stdout(line);
  };
  const peer = new AcpNdjsonPeer(write);
  const adapter = new AcpAdapter({
    app: client,
    peer,
    agentVersion: context.version,
  });
  const server = new AcpNdjsonServer({ adapter, peer, write });
  try {
    const lines = context.host.io.readLines?.();
    if (lines !== undefined) {
      for await (const line of lines) await server.push(line + "\n");
    } else {
      await server.push(await context.host.io.readStdin());
    }
    await server.end();
    return ok();
  } finally {
    peer.close();
    adapter.dispose();
    await client.close();
  }
}
