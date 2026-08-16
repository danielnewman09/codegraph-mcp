// Fake codegraph bridge for tests. Speaks the same newline-delimited JSON
// framing as bridge/codegraph_bridge.py. Launched via: node fake-bridge.mjs
//
// Methods:
//   ping  -> { ok: true, result: { ok: true, version: "fake" } }
//   echo  -> { ok: true, result: { echoed: <params> } }
//   query with format=html -> { ok: true, result: { html_path, title, scope, size } }
//   query with scope=kind  -> { ok: true, result: <40KB string> } (large-result guard)
//   explore with action=sources -> { ok: true, result: [{source, count}, ...] }
//   setup with action=status -> { ok: true, result: { ok: true, backend: "fake",
//                                database: {...}, sources: [...] } }
//   setup with action=index -> records the source (clear replaces), responds
//                              { ok: true, result: { exit_code: 0, source, format } }
//   slow  -> never responds (for timeout / shutdown-with-pending tests)
import { createInterface } from "node:readline";

// Simulated database: source label -> node count.
const db = new Map();

function sourcesList() {
  return [...db.entries()].map(([source, count]) => ({ source, count }));
}

function indexResult(params) {
  const source = params.source ?? "default";
  const count = 100 + (source.length * 37) % 9000;
  db.set(source, count);
  return {
    exit_code: 0,
    stdout: `Indexed ${source} (fake)`,
    stderr: "",
    source,
    clear: params.clear === true,
    project_dir: params.project_dir ?? null,
    format: params.format ?? "sqlite",
    backend: "sqlite",
  };
}

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "slow") return; // hang forever

  let result = { ok: true, version: "fake" };
  const p = msg.params ?? {};
  if (msg.method === "echo") {
    result = { echoed: p };
  } else if (msg.method === "cwd") {
    result = { cwd: process.cwd() };
  } else if (msg.method === "query" && p.format === "html") {
    result = { html_path: "/tmp/fake-render.html", title: "Fake Graph", scope: p.scope ?? "neighborhood", size: "large" };
  } else if (msg.method === "query" && p.scope === "kind") {
    result = "x".repeat(40_000);
  } else if (msg.method === "explore" && p.action === "sources") {
    // Real handler (bridge/handlers/explore.py → CodeGraphDispatcher) returns
    // a JSON *string* with an object map: {"sources": {"src": count}}.
    result = JSON.stringify({ sources: Object.fromEntries(db) });
  } else if (msg.method === "setup" && p.action === "status") {
    result = {
      ok: true,
      backend: "fake",
      tags: { available_tags: [] },
      database: {
        path: process.env.SQLITE_PATH ?? "/fake/codegraph.sqlite3",
        exists: true,
        size_bytes: 1024,
        total_nodes: 42,
        total_relationships: 7,
      },
      // The real status handler emits an array under the healthy backend
      // branch and a `{source: count}` map under the degraded branch —
      // mirror both, selected by env for contract tests.
      sources: process.env.FAKE_STATUS_SOURCES === "map"
        ? Object.fromEntries(db)
        : sourcesList(),
    };
  } else if (msg.method === "setup" && p.action === "index") {
    result = indexResult(p);
  } else if (msg.method === "setup" && p.action === "migrate_database") {
    // Mirrors bridge/handlers/setup.py:_handle_migrate_database result shape.
    const src = p.legacy_path ?? "";
    if (src.includes("missing")) {
      result = { ok: false, error: `legacy database not found: ${src}` };
    } else if (src.includes("not-a-db")) {
      result = { ok: false, error: `${src} is not a codegraph database (no nodes table)` };
    } else if (src.includes("bad-validation")) {
      result = {
        ok: true,
        source: src,
        destination: p.to_path ?? "/fake/dest.sqlite3",
        source_nodes: 7,
        source_edges: 4,
        destination_nodes: 3,
        destination_edges: 1,
        validated: false,
      };
    } else if (src === p.to_path) {
      result = { ok: false, error: "source and destination are the same file" };
    } else {
      const to = p.to_path ?? process.env.SQLITE_PATH ?? "/fake/dest.sqlite3";
      result = {
        ok: true,
        source: src,
        destination: to,
        source_nodes: 7,
        source_edges: 4,
        destination_nodes: 7,
        destination_edges: 4,
        preserved_original: null,
        validated: true,
      };
    }
  } else {
    result = { method: msg.method, echoed: p };
  }
  process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result }) + "\n");
});
