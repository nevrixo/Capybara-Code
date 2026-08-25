# Capybara Code App Protocol SDK

TypeScript package: `packages/sdk-typescript` (`@cbc/sdk`).
Python package: `packages/sdk-python` (`capybara_code`).

Both clients speak the App Protocol, not the internal Rust runtime RPC.

## Connect

```ts
import { CapybaraClient } from "@cbc/sdk";

const client = await CapybaraClient.connect({
  transport: process.platform === "win32" ? "pipe" : "unix",
  path: socketOrPipePath,
  client: { id: "sdk", name: "example", version: "1.0.0", kind: "sdk" },
});
const session = client.session(sessionId);
const turn = await session.submit("fix the parser");
for await (const event of session.events()) {
  if (event.kind === "turn.completed") break;
}
```

```python
from capybara_code import CapybaraClient

client = await CapybaraClient.connect(path=socket_path)
session = client.session(session_id)
handle = await session.submit("fix the parser")
```

Method names are generated from `packages/app-protocol` (`scripts/generate-sdk-types.ts`).
Handshake schema: `schemas/app/handshake.schema.json`.
RPC envelope: `schemas/app/rpc.schema.json`.

Reconnect by creating a subscription with the last `EventCursor` (`journalSequence`).
The server replays journaled events after that cursor; live events follow.
