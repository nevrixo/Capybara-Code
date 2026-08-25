# @cbc/sdk

TypeScript client for the Capybara Code App Protocol.

```ts
import { CapybaraClient } from "@cbc/sdk";

const client = await CapybaraClient.connect({
  transport: "unix",
  path: socketPath,
  client: { id: "sdk", name: "example", version: "1.0.0", kind: "sdk" },
});
```

See `docs/sdk.md` in the repository for reconnect and cursor semantics.
