/**
 * MCP integration tests — workspace-root discovery, project resolution
 * before bridge start, ambiguity handling, and root-change re-resolution.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ListRootsRequestSchema,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";

import { FAKE_BRIDGE, MCP_ENTRY, SpawnedStdioTransport, testPluginData } from "./helpers.js";

/** Fake bridge env: hermetic server tests need no Python/codegraph. */
const FAKE_ENV = { CODEGRAPH_PYTHON: "node", CODEGRAPH_BRIDGE: FAKE_BRIDGE };

interface ServerHandle {
  child: ChildProcess;
  stderr: string[];
  waitForExit(ms: number): Promise<number | null>;
}

/** Spawn the server with a roots-capable client; capture child stderr. */
async function startWithRoots(
  roots: Array<{ uri: string; name?: string }>,
  extraEnv: Record<string, string> = {},
): Promise<{ client: Client; transport: SpawnedStdioTransport; stderr: string[] }> {
  const child = spawn(process.execPath, ["--import", "tsx", MCP_ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PLUGIN_DATA: testPluginData(), ...FAKE_ENV, ...extraEnv },
  });
  const stderr: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d: string) => stderr.push(d));
  const transport = new SpawnedStdioTransport(child);
  const client = new Client(
    { name: "roots-test-client", version: "0.0.0" },
    { capabilities: { roots: { listChanged: true } } },
  );
  client.setRequestHandler(ListRootsRequestSchema, () => ({ roots }));
  await client.connect(transport);
  return { client, transport, stderr };
}

/** Give the server a moment to complete project resolution. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function writeManifestRoot(extra = ""): string {
  const dir = mkdtempSync(join(tmpdir(), "cg-root-"));
  writeFileSync(join(dir, ".codegraph-project.toml"), `schema_version = 1
[project]
id = "root-suite"
database = ".codegraph/codegraph.sqlite3"
[[repositories]]
name = "repo-a"
path = "repo-a"
source = "repo-a"
${extra}`);
  mkdirSync(join(dir, "repo-a"), { recursive: true });
  return dir;
}

// ── Manifest discovery from roots ─────────────────────────────────────────

test("MCP: workspace-root manifest selects the project before any bridge call", async () => {
  const dir = writeManifestRoot();
  const { client, transport, stderr } = await startWithRoots([{ uri: "file://" + dir }]);
  try {
    // The first tool call awaits project resolution, then executes.
    const res = await client.callTool({ name: "codegraph_setup", arguments: { action: "status" } });
    assert.equal(res.isError, false);
    const content = res.content as Array<{ type: string; text?: string }>;
    const text = content.find((c) => c.type === "text")?.text ?? "";
    assert.match(text, /root-suite/);
    assert.match(text, /repo-a/);
    assert.match(text, /\.codegraph[\\/]codegraph\.sqlite3/);
    // Resolution was logged before the bridge call completed.
    assert.ok(
      stderr.some((l) => /project 'root-suite' \(mcp-roots\)/.test(l)),
      `expected mcp-roots resolution in stderr: ${stderr.join("")}`,
    );
  } finally {
    await client.close();
    await transport.waitForExit(5_000);
  }
});

test("MCP: root ordering does not affect project identity", async () => {
  const dir = writeManifestRoot();
  const a = { uri: "file://" + dir };
  const other = { uri: "file://" + mkdtempSync(join(tmpdir(), "cg-other-")) };

  const h1 = await startWithRoots([a, other]);
  const db1 = await statusDatabasePath(h1.client);
  await h1.client.close();
  await h1.transport.waitForExit(5_000);

  const h2 = await startWithRoots([other, a]);
  const db2 = await statusDatabasePath(h2.client);
  await h2.client.close();
  await h2.transport.waitForExit(5_000);

  assert.equal(db1, db2, "reordered roots must select the same database");
});

async function statusDatabasePath(client: Client): Promise<string> {
  const res = await client.callTool({ name: "codegraph_setup", arguments: { action: "status" } });
  const content = res.content as Array<{ type: string; text?: string }>;
  const text = content.find((c) => c.type === "text")?.text ?? "";
  const parsed = JSON.parse(text) as { database?: { path?: string } };
  const path = parsed.database?.path;
  assert.ok(path, "status should report a database path");
  return path;
}

// ── Clients without roots ─────────────────────────────────────────────────

test("MCP: client without the roots capability falls back to explicit config", async () => {
  const pd = testPluginData();
  const db = join(pd, "explicit.sqlite3");
  const child = spawn(process.execPath, ["--import", "tsx", MCP_ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PLUGIN_DATA: pd,
      CODEGRAPH_PYTHON: "node",
      CODEGRAPH_BRIDGE: FAKE_BRIDGE,
      SQLITE_PATH: db,
    },
  });
  const stderr: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d: string) => stderr.push(d));
  const transport = new SpawnedStdioTransport(child);
  const client = new Client({ name: "no-roots-client", version: "0.0.0" }); // no roots capability
  await client.connect(transport);
  try {
    const path = await statusDatabasePath(client);
    // The runtime canonicalizes the explicit path (resolves symlinked tmpdirs).
    const { realpathSync } = await import("node:fs");
    const { dirname: dName, basename: bName } = await import("node:path");
    assert.equal(path, realpathSync(dName(db)) + "/" + bName(db));
    await sleep(100);
    assert.ok(
      stderr.some((l) => /\(absolute-sqlite\)/.test(l)),
      `expected absolute-sqlite resolution: ${stderr.join("")}`,
    );
  } finally {
    await client.close();
    await transport.waitForExit(5_000);
  }
});

test("MCP: client without the roots capability uses the fallback and reports unconfigured", async () => {
  const pd = testPluginData();
  const child = spawn(process.execPath, ["--import", "tsx", MCP_ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PLUGIN_DATA: pd, CODEGRAPH_PYTHON: "node", CODEGRAPH_BRIDGE: FAKE_BRIDGE },
  });
  const stderr: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d: string) => stderr.push(d));
  const transport = new SpawnedStdioTransport(child);
  const client = new Client({ name: "no-roots-client", version: "0.0.0" });
  await client.connect(transport);
  try {
    const path = await statusDatabasePath(client);
    assert.match(path, new RegExp(pd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[\\\\/]projects[\\\\/][a-f0-9]{16}[\\\\/]codegraph\\.sqlite3"));
    await sleep(100);
    assert.ok(
      stderr.some((l) => /\(fallback\)/.test(l)),
      `expected fallback resolution: ${stderr.join("")}`,
    );
  } finally {
    await client.close();
    await transport.waitForExit(5_000);
  }
});

// ── Ambiguity ─────────────────────────────────────────────────────────────

test("MCP: multiple root manifests are ambiguous — server exits without creating a database", async () => {
  const a = writeManifestRoot();
  const b = writeManifestRoot();
  const pd = testPluginData();
  const child = spawn(process.execPath, ["--import", "tsx", MCP_ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PLUGIN_DATA: pd, CODEGRAPH_PYTHON: "node", CODEGRAPH_BRIDGE: FAKE_BRIDGE },
  });
  const stderr: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d: string) => stderr.push(d));
  const transport = new SpawnedStdioTransport(child);
  const client = new Client(
    { name: "roots-test-client", version: "0.0.0" },
    { capabilities: { roots: { listChanged: true } } },
  );
  client.setRequestHandler(ListRootsRequestSchema, () => ({
    roots: [{ uri: "file://" + a }, { uri: "file://" + b }],
  }));
  await client.connect(transport);

  // The first tool call triggers resolution, which fails on ambiguity and
  // shuts the server down (exit != 0) without ever creating a database.
  await client.callTool({ name: "codegraph_stats", arguments: {} }).catch(() => {});
  const code = await transport.waitForExit(5_000);
  assert.notEqual(code, 0, "ambiguous project must fail the server startup");
  assert.ok(
    stderr.some((l) => /[Aa]mbiguous/.test(l)),
    `expected ambiguity diagnostic: ${stderr.join("")}`,
  );
  // No database must be created anywhere under the plugin data dir.
  const { existsSync } = await import("node:fs");
  const { join: pJoin } = await import("node:path");
  const projectsDir = pJoin(pd, "projects");
  assert.equal(existsSync(projectsDir), false, "no fallback project dir should be created on ambiguity");
});

// ── Root-change notifications ─────────────────────────────────────────────

test("MCP: roots/list_changed re-resolves the project and switches the database", async () => {
  const dirA = writeManifestRoot();
  const dirB = writeManifestRoot();
  const rootsHolder: Array<{ uri: string }> = [{ uri: "file://" + dirA }];
  const child = spawn(process.execPath, ["--import", "tsx", MCP_ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PLUGIN_DATA: testPluginData(), CODEGRAPH_PYTHON: "node", CODEGRAPH_BRIDGE: FAKE_BRIDGE },
  });
  const stderr: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d: string) => stderr.push(d));
  const transport = new SpawnedStdioTransport(child);
  const client = new Client(
    { name: "roots-test-client", version: "0.0.0" },
    { capabilities: { roots: { listChanged: true } } },
  );
  client.setRequestHandler(ListRootsRequestSchema, () => ({ roots: rootsHolder }));
  await client.connect(transport);
  try {
    await sleep(300);
    const dbA = await statusDatabasePath(client);

    // Change the roots and notify the server.
    rootsHolder.length = 0;
    rootsHolder.push({ uri: "file://" + dirB });
    await client.notification({ method: "notifications/roots/list_changed" });
    await sleep(500);

    const dbB = await statusDatabasePath(client);
    assert.notEqual(dbA, dbB, "roots change must select the new project database");
    assert.match(dbB, /\.codegraph[\\/]codegraph\.sqlite3$/);
    assert.ok(
      stderr.some((l) => /roots changed/.test(l)),
      `expected roots-changed log: ${stderr.join("")}`,
    );
  } finally {
    await client.close();
    await transport.waitForExit(5_000);
  }
});

// ── Plugin-bundle invariant at runtime ────────────────────────────────────

test("MCP: a manifest pointing the database into the plugin bundle is rejected", async () => {
  const pluginRoot = join(process.cwd(), "dist"); // bundle dir for the built server
  mkdirSync(join(pluginRoot, "cache"), { recursive: true });
  const manifestDir = join(pluginRoot, "cache", "project");
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(join(manifestDir, ".codegraph-project.toml"), `schema_version = 1
[project]
id = "bad"
database = "codegraph.sqlite3"
`);
  const child = spawn(process.execPath, ["--import", "tsx", MCP_ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PLUGIN_DATA: testPluginData(),
      CODEGRAPH_PROJECT_FILE: join(manifestDir, ".codegraph-project.toml"),
      CODEGRAPH_PYTHON: "node",
      CODEGRAPH_BRIDGE: FAKE_BRIDGE,
    },
  });
  const stderr: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d: string) => stderr.push(d));
  const transport = new SpawnedStdioTransport(child);
  const client = new Client({ name: "bad-manifest", version: "0.0.0" });
  await client.connect(transport);
  try {
    const res = await client.callTool({ name: "codegraph_stats", arguments: {} });
    assert.equal(res.isError, true, "plugin-bundle database must be rejected");
    const content = res.content as Array<{ type: string; text?: string }>;
    const text = content.find((c) => c.type === "text")?.text ?? "";
    assert.match(text, /plugin bundle/);
    // The server must stay alive and keep answering (no crash).
    const res2 = await client.callTool({ name: "codegraph_setup", arguments: { action: "status" } });
    assert.equal(res2.isError, true);
  } finally {
    await client.close();
    await transport.waitForExit(5_000);
  }
});

// ── Two fresh tasks select the same project database ──────────────────────

test("MCP: two fresh tasks for the same workspace select the same database (manifest)", async () => {
  // Replicates the Codex launch shape: the plugin's bundled server started
  // from the plugin bundle, given the same workspace roots twice, must pick
  // the same project database — and never one inside the plugin bundle.
  const dir = writeManifestRoot();
  const roots = [{ uri: "file://" + dir }];
  const a = await startWithRoots(roots);
  let dbA: string;
  try { dbA = await statusDatabasePath(a.client); } finally { await a.client.close(); await a.transport.waitForExit(5_000); }
  const b = await startWithRoots(roots);
  let dbB: string;
  try { dbB = await statusDatabasePath(b.client); } finally { await b.client.close(); await b.transport.waitForExit(5_000); }
  assert.equal(dbA, dbB, "fresh tasks for the same workspace must share the project database");
  assert.ok(!dbA.includes(process.cwd()), "database must never resolve inside the plugin bundle");
});

test("MCP: two fresh tasks without a manifest share the fallback database, not the plugin cache", async () => {
  // The original bug: a relative SQLITE_PATH resolved against the plugin
  // launch cwd, so each task created a database in the plugin bundle.  The
  // fallback must be keyed on the workspace roots and live under PLUGIN_DATA.
  const dir = mkdtempSync(join(tmpdir(), "cg-unconfigured-"));
  const pdA = testPluginData();
  const pdB = testPluginData();
  const roots = [{ uri: "file://" + dir }];

  async function fallbackDb(pd: string): Promise<string> {
    const child = spawn(process.execPath, ["--import", "tsx", MCP_ENTRY], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PLUGIN_DATA: pd, CODEGRAPH_PYTHON: "node", CODEGRAPH_BRIDGE: FAKE_BRIDGE },
    });
    const transport = new SpawnedStdioTransport(child);
    const client = new Client(
      { name: "fallback-client", version: "0.0.0" },
      { capabilities: { roots: { listChanged: true } } },
    );
    client.setRequestHandler(ListRootsRequestSchema, () => ({ roots }));
    await client.connect(transport);
    try {
      return await statusDatabasePath(client);
    } finally {
      await client.close();
      await transport.waitForExit(5_000);
    }
  }

  const dbA = await fallbackDb(pdA);
  const dbB = await fallbackDb(pdB);
  // Same workspace, different plugin-data dirs → the same relative key but
  // each task's database lives under its own PLUGIN_DATA (never the bundle).
  assert.match(dbA, new RegExp(pdA.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(dbB, new RegExp(pdB.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const keyA = dbA.split(/[\\/]projects[\\/]/)[1]?.split(/[\\/]/)[0];
  const keyB = dbB.split(/[\\/]projects[\\/]/)[1]?.split(/[\\/]/)[0];
  assert.equal(keyA, keyB, "the fallback hash must be identical for the same roots");
  assert.ok(!dbA.includes(process.cwd()) && !dbB.includes(process.cwd()), "never the plugin cache");
});
