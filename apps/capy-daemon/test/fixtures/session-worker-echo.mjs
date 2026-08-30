import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
let heldTurn;
for await (const line of rl) {
  if (!line.trim()) continue;
  const message = JSON.parse(line);
  const send = (result) => process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id: message.id,
    result,
  }) + "\n");
  if (message.method === "turn.submit") {
    heldTurn = message;
    continue;
  }
  send({ method: message.method, params: message.params });
  if (heldTurn !== undefined) {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: heldTurn.id,
      result: {
        turnId: heldTurn.params.turnId,
        status: "completed",
        answer: heldTurn.params.prompt,
      },
    }) + "\n");
    heldTurn = undefined;
  }
}
