// Fake codegraph bridge for tests. Speaks the same newline-delimited JSON
// framing as bridge/codegraph_bridge.py. Launched via: node fake-bridge.mjs
//
// Methods:
//   ping  -> { ok: true, result: { ok: true, version: "fake" } }
//   echo  -> { ok: true, result: { echoed: <params> } }
//   slow  -> never responds (for timeout / shutdown-with-pending tests)
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "slow") return; // hang forever
  let result = { ok: true, version: "fake" };
  if (msg.method === "echo") result = { echoed: msg.params ?? {} };
  process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result }) + "\n");
});
