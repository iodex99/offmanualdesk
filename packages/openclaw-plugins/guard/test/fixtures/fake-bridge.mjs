// Stand-in for `server-agent bridge` in tests: answers NDJSON JSON-RPC on stdio.
// Behaviour per method: lock.get → unlocked; slow.* never answers; crash → exits.
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.method === "lock.get") {
    process.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { locked: false, dayUnlocked: true } }) + "\n",
    );
  } else if (req.method === "audit.append") {
    if (req.params?.category !== "access_denied") {
      process.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32602, message: "invalid params" } }) +
          "\n",
      );
    } else {
      process.stdout.write("not json at all\n");
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: true } }) + "\n");
    }
  } else if (req.method === "policy.get") {
    process.exit(3); // simulate the bridge dying mid-call
  }
});
