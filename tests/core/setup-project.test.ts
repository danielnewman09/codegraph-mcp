/**
 * Setup executor tests — manifest repository selection, `index_all`, and
 * status enrichment against the fake bridge.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CodegraphRuntime } from "../../src/core/runtime.js";
import { resolveConfig } from "../../src/core/config.js";
import { resolveProjectContext } from "../../src/core/project.js";
import { setupTool } from "../../src/core/tool-catalog.js";
import type { ToolResult } from "../../src/core/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_BRIDGE = join(__dirname, "..", "fixtures", "fake-bridge.mjs");

interface RepoSetup {
  name: string;
  source: string;
  index?: boolean;
}

/** Build a temp multi-repo project with a manifest + fake-bridge runtime. */
function makeProject(repos: RepoSetup[]): {
  dir: string;
  runtime: CodegraphRuntime;
} {
  const dir = mkdtempSync(join(tmpdir(), "cg-setup-proj-"));
  const reposToml = repos.map((r) =>
    `[[repositories]]\nname = "${r.name}"\npath = "repos/${r.name}"\nsource = "${r.source}"\n` +
    (r.index === false ? `index = false\n` : ""),
  ).join("\n");
  const manifest = `schema_version = 1
[project]
id = "test-suite"
database = ".codegraph/codegraph.sqlite3"

${reposToml}`;
  writeFileSync(join(dir, ".codegraph-project.toml"), manifest);
  for (const r of repos) {
    mkdirSync(join(dir, "repos", r.name), { recursive: true });
  }

  const config = resolveConfig({
    python: "node",
    bridgePath: FAKE_BRIDGE,
  }, {}, dir);
  const project = resolveProjectContext({
    env: { CODEGRAPH_PROJECT_FILE: join(dir, ".codegraph-project.toml") },
    cwd: dir,
    pluginDataDir: join(dir, "pd"),
    pluginRoot: join(mkdtempSync(join(tmpdir(), "cg-plugin-")), "bundle"),
  });
  return { dir, runtime: new CodegraphRuntime(config, project) };
}

async function runSetup(
  rt: CodegraphRuntime,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    return await setupTool.execute(rt, params, {});
  } finally {
    await rt.stopBridge().catch(() => {});
  }
}

function details(r: ToolResult): Record<string, unknown> {
  return (r as { details?: Record<string, unknown> }).details ?? {};
}

/** Run an executor against a runtime without stopping the bridge after the call. */
async function callSetup(
  rt: CodegraphRuntime,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  return setupTool.execute(rt, params, {});
}

// ── Repository selection ──────────────────────────────────────────────────

test("setup: repository resolves project_dir + source from the manifest", async () => {
  const { runtime } = makeProject([
    { name: "a", source: "src-a" },
    { name: "b", source: "src-b" },
  ]);
  const r = await runSetup(runtime, { action: "index", repository: "b" });
  assert.equal(r.ok, true);
  const raw = details(r).raw as { source: string; project_dir: string };
  assert.equal(raw.source, "src-b");
  assert.ok(raw.project_dir.endsWith(join("repos", "b")));
});

test("setup: index with a single enabled repository auto-selects it", async () => {
  const { runtime } = makeProject([{ name: "only", source: "only-src" }]);
  const r = await runSetup(runtime, { action: "index" });
  assert.equal(r.ok, true);
  const raw = details(r).raw as { source: string };
  assert.equal(raw.source, "only-src");
});

test("setup: index without repository/project_dir and multiple enabled repos is ambiguous", async () => {
  const { runtime } = makeProject([
    { name: "a", source: "a" },
    { name: "b", source: "b" },
  ]);
  const r = await runSetup(runtime, { action: "index" });
  assert.equal(r.ok, false);
  assert.match(r.text, /ambiguous/i);
});

test("setup: index with zero enabled repositories errors", async () => {
  const { runtime } = makeProject([{ name: "off", source: "off", index: false }]);
  const r = await runSetup(runtime, { action: "index" });
  assert.equal(r.ok, false);
  assert.match(r.text, /no enabled repositories/);
});

test("setup: unknown repository lists the manifest repositories", async () => {
  const { runtime } = makeProject([{ name: "a", source: "a" }]);
  const r = await runSetup(runtime, { action: "index", repository: "nope" });
  assert.equal(r.ok, false);
  assert.match(r.text, /unknown repository 'nope'/);
  assert.match(r.text, /'a'/);
});

test("setup: disabled repository cannot be indexed", async () => {
  const { runtime } = makeProject([
    { name: "on", source: "on" },
    { name: "off", source: "off", index: false },
  ]);
  const r = await runSetup(runtime, { action: "index", repository: "off" });
  assert.equal(r.ok, false);
  assert.match(r.text, /disabled/);
});

test("setup: missing repository path errors before dispatch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cg-missing-"));
  writeFileSync(join(dir, ".codegraph-project.toml"), `schema_version = 1
[project]
id = "t"
database = "db.sqlite3"
[[repositories]]
name = "gone"
path = "no-such-dir"
`);
  const config = resolveConfig({ python: "node", bridgePath: FAKE_BRIDGE }, {}, dir);
  const project = resolveProjectContext({
    env: { CODEGRAPH_PROJECT_FILE: join(dir, ".codegraph-project.toml") },
    cwd: dir,
    pluginDataDir: join(dir, "pd"),
    pluginRoot: join(mkdtempSync(join(tmpdir(), "cg-plugin-")), "bundle"),
  });
  const rt = new CodegraphRuntime(config, project);
  const r = await runSetup(rt, { action: "index", repository: "gone" });
  assert.equal(r.ok, false);
  assert.match(r.text, /does not exist/);
});

test("setup: conflicting repository + project_dir / source forms are rejected", async () => {
  const { runtime, dir } = makeProject([{ name: "a", source: "src-a" }]);
  const r1 = await runSetup(runtime, { action: "index", repository: "a", project_dir: join(dir, "elsewhere") });
  assert.equal(r1.ok, false);
  assert.match(r1.text, /conflicting arguments/);

  const r2 = await runSetup(runtime, { action: "index", repository: "a", source: "other" });
  assert.equal(r2.ok, false);
  assert.match(r2.text, /conflicting arguments/);
});

test("setup: repository requires an active project manifest", async () => {
  const config = resolveConfig({ python: "node", bridgePath: FAKE_BRIDGE }, {}, process.cwd());
  const rt = new CodegraphRuntime(config); // no project
  const r = await runSetup(rt, { action: "index", repository: "a" });
  assert.equal(r.ok, false);
  assert.match(r.text, /requires an active project manifest/);
});

test("setup: legacy index without a project and without project_dir errors", async () => {
  const config = resolveConfig({ python: "node", bridgePath: FAKE_BRIDGE }, {}, process.cwd());
  const rt = new CodegraphRuntime(config); // no project
  const r = await runSetup(rt, { action: "index" });
  assert.equal(r.ok, false);
  assert.match(r.text, /needs a project_dir/);
});

// ── index_all ─────────────────────────────────────────────────────────────

test("index_all: indexes every enabled repository sequentially with node counts", async () => {
  const { runtime } = makeProject([
    { name: "a", source: "src-a" },
    { name: "b", source: "src-b" },
    { name: "venv", source: "venv", index: false },
  ]);
  const r = await runSetup(runtime, { action: "index_all", clear: true });
  assert.equal(r.ok, true);
  assert.match(r.text, /2\/2 repositories indexed/);
  const results = details(r).results as Array<{
    repository: string;
    source: string;
    status: string;
    node_count?: number;
    duration_ms: number;
  }>;
  assert.equal(results.length, 2, "disabled entries are skipped");
  assert.deepEqual(results.map((x) => x.repository), ["a", "b"]);
  for (const entry of results) {
    assert.equal(entry.status, "ok");
    assert.equal(typeof entry.duration_ms, "number");
  }
  // Node counts come from the real explore-sources contract: a JSON string
  // `{"sources": {"<src>": count}}`.  The fake bridge computes
  // count = 100 + (source.length * 37) % 9000; "src-a".length === 5.
  assert.equal(results[0].node_count, 285);
  assert.equal(results[1].node_count, 285);
  assert.equal(details(r).project, "test-suite");
});

test("index_all: clear=true is forwarded to each per-repository index call", async () => {
  const { runtime } = makeProject([
    { name: "a", source: "src-a" },
    { name: "b", source: "src-b" },
  ]);
  try {
    // One bridge session: the fake bridge's source table is in-memory.
    const r = await callSetup(runtime, { action: "index_all", clear: true });
    assert.equal(r.ok, true);
    const results = details(r).results as Array<{ source: string; status: string }>;
    assert.equal(results.length, 2);

    const status = await callSetup(runtime, { action: "status" });
    assert.equal(status.ok, true);
    const raw = details(status).raw as { repositories: Array<{ source: string; indexed: boolean; node_count: number }> };
    const repos = raw.repositories;
    assert.deepEqual(repos.map((x) => [x.source, x.indexed]), [
      ["src-a", true],
      ["src-b", true],
    ]);
    assert.ok(repos.every((x) => x.node_count > 0));
  } finally {
    await runtime.stopBridge().catch(() => {});
  }
});

test("index_all: requires an active project manifest", async () => {
  const config = resolveConfig({ python: "node", bridgePath: FAKE_BRIDGE }, {}, process.cwd());
  const rt = new CodegraphRuntime(config);
  const r = await runSetup(rt, { action: "index_all" });
  assert.equal(r.ok, false);
  assert.match(r.text, /requires an active project manifest/);
});

test("index_all: aborts with a per-repository result when the manifest has no enabled repos", async () => {
  const { runtime } = makeProject([{ name: "off", source: "off", index: false }]);
  const r = await runSetup(runtime, { action: "index_all" });
  assert.equal(r.ok, false);
  assert.match(r.text, /no enabled repositories/);
});

test("index_all: a bridge failure of one repo preserves the others' results", async () => {
  const { runtime } = makeProject([
    { name: "a", source: "src-a" },
    { name: "b", source: "src-b" },
  ]);
  // Fail the second index dispatch (repo b) at the bridge level; the first
  // repo must still succeed and appear in the per-repository summary.
  const failing = Object.create(runtime) as CodegraphRuntime;
  let setupCalls = 0;
  failing.call = async (method: string, params: Record<string, unknown>) => {
    if (method === "setup" && (params.action as string) === "index") {
      setupCalls += 1;
      if (setupCalls === 2) throw new Error("bridge exploded for repo b");
    }
    return runtime.call(method, params);
  };
  try {
    const r = await setupTool.execute(failing, { action: "index_all" }, {});
    assert.equal(r.ok, false);
    const results = details(r).results as Array<{ repository: string; status: string; error?: string }>;
    assert.equal(results.length, 2);
    assert.equal(results[0].repository, "a");
    assert.equal(results[0].status, "ok", "repo a must survive repo b's failure");
    assert.equal(results[1].repository, "b");
    assert.equal(results[1].status, "failed");
    assert.match(results[1].error ?? "", /bridge exploded/);
    assert.match(r.text, /1\/2 repositories indexed/);
    assert.match(r.text, /successful sources preserved/);
  } finally {
    await runtime.stopBridge().catch(() => {});
  }
});

// ── Status enrichment ─────────────────────────────────────────────────────

test("status: reports project + database + per-repository indexed state", async () => {
  const { runtime } = makeProject([
    { name: "a", source: "src-a" },
    { name: "b", source: "src-b", index: false },
  ]);
  try {
    // Index a (and skip disabled b) within one bridge session.
    const idx = await callSetup(runtime, { action: "index_all" });
    assert.equal(idx.ok, true);

    const r = await callSetup(runtime, { action: "status" });
    assert.equal(r.ok, true);
    const d = details(r);
    const raw = d.raw as Record<string, unknown>;
    assert.deepEqual(raw.project, {
      id: "test-suite",
      manifest: join((raw.project as { directory: string }).directory, ".codegraph-project.toml"),
      directory: (raw.project as { directory: string }).directory,
      discovery_source: "explicit",
    });
    const repos = raw.repositories as Array<{
      name: string;
      source: string;
      enabled: boolean;
      exists: boolean;
      indexed: boolean;
      node_count: number;
    }>;
    assert.equal(repos.length, 2);
    const a = repos.find((x) => x.name === "a")!;
    const b = repos.find((x) => x.name === "b")!;
    assert.equal(a.indexed, true);
    assert.ok(a.node_count > 0);
    assert.equal(a.enabled, true);
    assert.equal(a.exists, true);
    assert.equal(b.indexed, false, "disabled repos are never indexed");
    assert.equal(b.enabled, false);
    // Database info comes from the backend (bridge) — present in raw.
    assert.ok((d.raw as { database?: unknown }).database, "status includes backend database info");
  } finally {
    await runtime.stopBridge().catch(() => {});
  }
});

test("status: without a project context passes the bridge result through", async () => {
  const config = resolveConfig({ python: "node", bridgePath: FAKE_BRIDGE }, {}, process.cwd());
  const rt = new CodegraphRuntime(config);
  const r = await runSetup(rt, { action: "status" });
  assert.equal(r.ok, true);
  assert.match(r.text, /"backend": "fake"/);
  assert.equal(details(r).project, undefined);
});

test("status: per-repository counts work with the degraded map-shaped sources response", async () => {
  const prev = process.env.FAKE_STATUS_SOURCES;
  process.env.FAKE_STATUS_SOURCES = "map";
  const { runtime } = makeProject([{ name: "a", source: "src-a" }]);
  try {
    // One bridge session: index registers the source in the fake DB.
    const idx = await callSetup(runtime, { action: "index_all" });
    assert.equal(idx.ok, true);
    const r = await callSetup(runtime, { action: "status" });
    assert.equal(r.ok, true);
    const repos = (details(r).raw as { repositories: Array<{ source: string; indexed: boolean; node_count: number }> }).repositories;
    const a = repos.find((x) => x.source === "src-a")!;
    assert.equal(a.indexed, true);
    assert.equal(a.node_count, 285, "map-shaped status sources must populate node counts");
  } finally {
    if (prev === undefined) delete process.env.FAKE_STATUS_SOURCES;
    else process.env.FAKE_STATUS_SOURCES = prev;
    await runtime.stopBridge().catch(() => {});
  }
});

// ── migrate_database result surfacing ─────────────────────────────────────

test("migrate_database: action-level failure is surfaced as a failed tool call", async () => {
  const { runtime } = makeProject([{ name: "a", source: "src-a" }]);
  for (const legacy of ["missing.sqlite3", "not-a-db.sqlite3"]) {
    const r = await runSetup(runtime, { action: "migrate_database", legacy_path: join("/legacy", legacy), to_path: "/dest/db.sqlite3" });
    assert.equal(r.ok, false, `${legacy}: migration failure must fail the tool call`);
    assert.match(r.text, /migrate_database failed/);
  }
  // Same-path refusal is also an action-level failure.
  const same = await runSetup(runtime, { action: "migrate_database", legacy_path: "/same/db.sqlite3", to_path: "/same/db.sqlite3" });
  assert.equal(same.ok, false);
  assert.match(same.text, /migrate_database failed/);
});

test("migrate_database: unvalidated copies are surfaced as failed tool calls", async () => {
  const { runtime } = makeProject([{ name: "a", source: "src-a" }]);
  const r = await runSetup(runtime, { action: "migrate_database", legacy_path: "/legacy/bad-validation.sqlite3", to_path: "/dest/db.sqlite3" });
  assert.equal(r.ok, false);
  assert.match(r.text, /did not validate/);
});

test("migrate_database: a successful validated copy is a successful tool call", async () => {
  const { runtime } = makeProject([{ name: "a", source: "src-a" }]);
  const r = await runSetup(runtime, { action: "migrate_database", legacy_path: "/legacy/good.sqlite3", to_path: "/dest/db.sqlite3" });
  assert.equal(r.ok, true);
  const raw = details(r).raw as { validated: boolean; destination_nodes: number };
  assert.equal(raw.validated, true);
  assert.equal(raw.destination_nodes, 7);
});

// ── Runtime → bridge wiring ───────────────────────────────────────────────

test("runtime: the bridge child receives the absolute SQLITE_PATH of the project", async () => {
  const { runtime } = makeProject([{ name: "a", source: "src-a" }]);
  const r = await runSetup(runtime, { action: "status" });
  assert.equal(r.ok, true);
  const database = (details(r).raw as { database: { path: string } }).database;
  // The fake bridge reports process.env.SQLITE_PATH — proving the runtime
  // passed the resolved absolute project database to the child.
  assert.match(database.path, /\.codegraph[\\/]codegraph\.sqlite3$/);
  assert.ok(database.path.startsWith("/"), "path must be absolute");
});

test("runtime: the bridge child runs with the project directory as cwd", async () => {
  const { runtime, dir } = makeProject([{ name: "a", source: "src-a" }]);
  try {
    const b = await runtime.ensureBridge();
    const res = await b.call("cwd", {}, 5_000);
    assert.equal(res.ok, true);
    assert.equal((res.result as { cwd: string }).cwd, realpathSync(dir), "bridge cwd must be the project dir");
  } finally {
    await runtime.stopBridge().catch(() => {});
  }
});

test("runtime: relative bridge/python paths stay valid under a project cwd", async () => {
  // CODEGRAPH_BRIDGE as a relative path must be normalized against the TS
  // process cwd — not the bridge child's (project) cwd.
  const { runtime } = makeProject([{ name: "a", source: "src-a" }]);
  const rel = join("tests", "fixtures", "fake-bridge.mjs");
  const cfg = resolveConfig({ python: "node", bridgePath: rel }, {}, process.cwd());
  const rt = new CodegraphRuntime(cfg, runtime.project);
  try {
    const b = await rt.ensureBridge();
    const res = await b.call("ping", {}, 5_000);
    assert.equal(res.ok, true);
  } finally {
    await rt.stopBridge().catch(() => {});
  }
});

test("runtime: updateProject waits for active bridge calls before replacing the bridge", async () => {
  const { runtime } = makeProject([{ name: "a", source: "src-a" }]);
  try {
    await runtime.ensureBridge();
    // Deliberately blocked call: the fake bridge never answers "slow".
    const slow = runtime.call("slow", {}, 400).then(
      () => "resolved",
      (e: Error) => `rejected: ${e.message}`,
    );
    await new Promise((r) => setTimeout(r, 50)); // let the call register

    // A roots-changed-style project swap must not kill the active call.
    let swapped = false;
    const upd = runtime.updateProject(null).then(() => { swapped = true; });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(swapped, false, "updateProject must wait for the in-flight call");

    const slowMsg = await slow;
    assert.match(slowMsg, /timed out/, "the active call must complete (time out) first");
    await upd;
    assert.equal(swapped, true, "updateProject completes after the call settles");
  } finally {
    await runtime.stopBridge().catch(() => {});
  }
});

test("runtime: updateProject applies immediately when no call is active", async () => {
  const { runtime } = makeProject([{ name: "a", source: "src-a" }]);
  const { runtime: other } = makeProject([{ name: "b", source: "src-b" }]);
  try {
    await runtime.ensureBridge();
    const started = Date.now();
    await runtime.updateProject(other.project);
    assert.ok(Date.now() - started < 500, "idle swap should be immediate");
    assert.equal(runtime.project!.id, other.project!.id);
  } finally {
    await runtime.stopBridge().catch(() => {});
  }
});

test("runtime: project database parent directory is created before bridge start", async () => {
  const { runtime, dir } = makeProject([{ name: "a", source: "src-a" }]);
  await runtime.ensureBridge();
  const db = runtime.project!.databasePath;
  assert.ok(existsSync(dirname(db)), "db parent dir must exist");
  await runtime.stopBridge().catch(() => {});
});
