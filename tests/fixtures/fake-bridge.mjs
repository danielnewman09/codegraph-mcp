// Fake codegraph bridge for tests. Speaks the same newline-delimited JSON
// framing as bridge/codegraph_bridge.py. Launched via: node fake-bridge.mjs
//
// Methods:
//   ping  -> { ok: true, result: { ok: true, version: "fake" } }
//   echo  -> { ok: true, result: { echoed: <params> } }
//   query with format=html -> { ok: true, result: { html_path, title, scope, size } }
//   query with scope=kind  -> { ok: true, result: <40KB string> } (large-result guard)
//   setup with action=status -> { ok: true, result: { ok: true, backend: "fake" } }
//   slow  -> never responds (for timeout / shutdown-with-pending tests)
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "slow") return; // hang forever

  let result = { ok: true, version: "fake" };
  const p = msg.params ?? {};
  if (msg.method === "echo") {
    result = { echoed: p };
  } else if (msg.method === "query" && p.format === "html") {
    result = { html_path: "/tmp/fake-render.html", title: "Fake Graph", scope: p.scope ?? "neighborhood", size: "large" };
  } else if (msg.method === "query" && p.scope === "kind") {
    result = "x".repeat(40_000);
  } else if (msg.method === "setup" && p.action === "status") {
    result = { ok: true, backend: "fake", tags: { available_tags: [] } };
  } else {
    result = { method: msg.method, echoed: p };
  }
  process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result }) + "\n");
});
