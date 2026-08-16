/**
 * Phase 1 unit tests — bridge lifecycle (idempotence, shutdown with
 * pending calls, per-call timeout) using a fake bridge child process,
 * plus subprocess runner behavior and runtime result conversion.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CodegraphBridge } from "../../src/core/bridge.js";
import { runProcess } from "../../src/core/subprocess.js";
import { fromBridgeResponse, bridgeResultFromResponse } from "../../src/core/results.js";
import { CodegraphRuntime } from "../../src/core/runtime.js";
import { resolveConfig } from "../../src/core/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_BRIDGE = join(__dirname, "..", "fixtures", "fake-bridge.mjs");

/** A bridge that runs the fake bridge script via `node`. */
function fakeBridge(timeoutMs = 5_000): CodegraphBridge {
  return new CodegraphBridge("node", FAKE_BRIDGE, {});
}

// ── Bridge start idempotence ─────────────────────────────────────────────

test("bridge start is idempotent under concurrent calls", async () => {
  const b = fakeBridge();
  const p1 = b.start();
  const p2 = b.start();
  await Promise.all([p1, p2]);
  assert.ok(b.isRunning(), "bridge should be running after start");
  const ping = await b.call("ping", {}, 5_000);
  assert.equal(ping.ok, true);
  await b.stop();
});

test("bridge call/echo round-trip", async () => {
  const b = fakeBridge();
  await b.start();
  const res = await b.call("echo", { hello: "world" }, 5_000);
  assert.equal(res.ok, true);
  assert.deepEqual(res.result, { echoed: { hello: "world" } });
  await b.stop();
});

// ── Bridge child cwd ──────────────────────────────────────────────────────

test("bridge spawns the child with an explicit working directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cg-bridge-cwd-"));
  const b = new CodegraphBridge("node", FAKE_BRIDGE, {}, { cwd: dir });
  await b.start();
  const res = await b.call("cwd", {}, 5_000);
  assert.equal(res.ok, true);
  assert.deepEqual(res.result, { cwd: realpathSync(dir) });
  await b.stop();
});

test("bridge without an explicit cwd keeps the parent cwd", async () => {
  const b = fakeBridge();
  await b.start();
  const res = await b.call("cwd", {}, 5_000);
  assert.equal(res.ok, true);
  assert.equal((res.result as { cwd: string }).cwd, process.cwd());
  await b.stop();
});

// ── Per-call timeout ──────────────────────────────────────────────────────

test("bridge per-call timeout rejects and leaves the bridge alive", async () => {
  const b = fakeBridge();
  await b.start();
  await assert.rejects(
    b.call("slow", {}, 300),
    /timed out after 300ms/,
  );
  // The bridge should still answer subsequent calls.
  const ping = await b.call("ping", {}, 5_000);
  assert.equal(ping.ok, true);
  await b.stop();
});

// ── Shutdown with pending calls ───────────────────────────────────────────

test("bridge stop rejects pending calls", async () => {
  const b = fakeBridge();
  await b.start();
  const pending = b.call("slow", {}, 10_000).then(
    () => { throw new Error("should have been rejected"); },
    (e: Error) => e.message,
  );
  await b.stop();
  const msg = await pending;
  assert.match(msg, /stopped/);
  assert.equal(b.isRunning(), false);
});

test("bridge stop is idempotent", async () => {
  const b = fakeBridge();
  await b.start();
  await b.stop();
  await b.stop(); // second stop must not throw
  assert.equal(b.isRunning(), false);
});

// ── Subprocess runner ─────────────────────────────────────────────────────

test("runProcess captures stdout/stderr and exit code", async () => {
  const r = await runProcess({
    command: process.execPath,
    args: ["-e", "console.log('out'); console.error('err'); process.exit(3)"],
  });
  assert.equal(r.code, 3);
  assert.equal(r.stdout.trim(), "out");
  assert.equal(r.stderr.trim(), "err");
});

test("runProcess honours timeout", async () => {
  const r = await runProcess({
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 60_000)"],
    timeoutMs: 300,
  });
  assert.equal(r.timedOut, true);
  assert.equal(r.killed, true);
  assert.notEqual(r.code, 0);
});

test("runProcess honours abort signal", async () => {
  const ac = new AbortController();
  const p = runProcess({
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 60_000)"],
    signal: ac.signal,
  });
  ac.abort();
  const r = await p;
  assert.equal(r.killed, true);
});

// ── Result conversion ─────────────────────────────────────────────────────

test("fromBridgeResponse converts success and failure", () => {
  const ok = fromBridgeResponse({ ok: true, result: { a: 1 } });
  assert.equal(ok.ok, true);
  assert.equal(ok.text, JSON.stringify({ a: 1 }, null, 2));

  const fail = fromBridgeResponse({ ok: false, error: "boom" });
  assert.equal(fail.ok, false);
  assert.equal(fail.text, "boom");
});

test("bridgeResultFromResponse keeps method details", () => {
  const r = bridgeResultFromResponse({ ok: true, result: "hi" }, { method: "ping" });
  assert.deepEqual(r.details, { method: "ping" });
});

// ── Runtime wiring ────────────────────────────────────────────────────────

test("runtime.call uses the configured bridge and returns BridgeCallResult", async () => {
  const config = resolveConfig({
    python: "node",
    bridgePath: FAKE_BRIDGE,
  }, {}, process.cwd());
  const rt = new CodegraphRuntime(config);
  const res = await rt.call("echo", { x: 1 });
  assert.equal(res.ok, true);
  assert.equal(res.text, JSON.stringify({ echoed: { x: 1 } }, null, 2));
  await rt.stopBridge();
});

test("runtime.ensureBridge is idempotent", async () => {
  const config = resolveConfig({
    python: "node",
    bridgePath: FAKE_BRIDGE,
  }, {}, process.cwd());
  const rt = new CodegraphRuntime(config);
  const b1 = await rt.ensureBridge();
  const b2 = await rt.ensureBridge();
  assert.equal(b1, b2, "ensureBridge must return the same instance");
  await rt.stopBridge();
});
