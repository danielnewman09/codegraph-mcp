/**
 * Project manifest + resolution tests — multi-repository project database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseProjectManifest,
  loadProjectManifest,
  resolveProjectContext,
  workspaceFallbackKey,
  assertDatabaseOutsidePlugin,
  ProjectError,
  isPathInside,
  type WorkspaceRoot,
} from "../../src/core/project.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "cg-proj-"));
}

function writeManifest(dir: string, body: string): string {
  const p = join(dir, ".codegraph-project.toml");
  writeFileSync(p, body);
  return p;
}

const VALID_MANIFEST = `schema_version = 1

[project]
id = "codegraph-suite"
database = ".codegraph/codegraph.sqlite3"

[[repositories]]
name = "codegraph"
path = "."
source = "codegraph"

[[repositories]]
name = "codegraph-mcp"
path = "../codegraph-mcp"
index = false
`;

// ── Parsing & validation ──────────────────────────────────────────────────

test("manifest: parses a valid multi-repository manifest", () => {
  const dir = tmpDir();
  mkdirSync(join(dir, "repos", "a"), { recursive: true });
  mkdirSync(join(dir, "repos", "b"), { recursive: true });
  const p = writeManifest(dir, `schema_version = 1
[project]
id = "suite"
database = ".codegraph/db.sqlite3"
[[repositories]]
name = "a"
path = "repos/a"
[[repositories]]
name = "b"
path = "repos/b"
source = "bee"
`);
  const m = parseProjectManifest(
    `schema_version = 1
[project]
id = "suite"
database = ".codegraph/db.sqlite3"
[[repositories]]
name = "a"
path = "repos/a"
[[repositories]]
name = "b"
path = "repos/b"
source = "bee"
`,
    p,
  );
  assert.equal(m.schemaVersion, 1);
  assert.equal(m.id, "suite");
  assert.equal(m.database, ".codegraph/db.sqlite3");
  assert.equal(m.repositories.length, 2);
  // source defaults to name
  assert.equal(m.repositories[0].source, "a");
  assert.equal(m.repositories[1].source, "bee");
  // index defaults to true
  assert.equal(m.repositories[0].index, true);
});

test("manifest: resolves relative paths against the manifest dir", () => {
  const dir = tmpDir();
  mkdirSync(join(dir, "repos", "a"), { recursive: true });
  const p = writeManifest(dir, `schema_version = 1
[project]
id = "suite"
database = ".codegraph/db.sqlite3"
[[repositories]]
name = "a"
path = "repos/a"
`);
  const m = parseProjectManifest(`schema_version = 1
[project]
id = "suite"
database = ".codegraph/db.sqlite3"
[[repositories]]
name = "a"
path = "repos/a"
`, p);
  assert.equal(m.manifestDir, realpathSync(dir));
});

test("manifest: rejects unsupported schema versions", () => {
  const dir = tmpDir();
  const p = writeManifest(dir, `schema_version = 2\n[project]\nid = "x"\ndatabase = "d"\n`);
  assert.throws(() => parseProjectManifest(`schema_version = 2
[project]
id = "x"
database = "d"
`, p), /schema_version/);
});

test("manifest: rejects missing schema_version", () => {
  const dir = tmpDir();
  const p = writeManifest(dir, `[project]\nid = "x"\ndatabase = "d"\n`);
  assert.throws(() => parseProjectManifest(`[project]
id = "x"
database = "d"
`, p), /schema_version/);
});

test("manifest: rejects malformed TOML", () => {
  const dir = tmpDir();
  const p = writeManifest(dir, "schema_version = = =");
  assert.throws(() => parseProjectManifest("schema_version = = =", p), /TOML/);
});

test("manifest: rejects missing/unsafe project.id and database", () => {
  const dir = tmpDir();
  assert.throws(
    () => parseProjectManifest(`schema_version = 1
[project]
database = "d"
`, join(dir, "m.toml")),
    /project\.id/,
  );
  assert.throws(
    () => parseProjectManifest(`schema_version = 1
[project]
id = "../evil"
database = "d"
`, join(dir, "m.toml")),
    /filesystem-safe/,
  );
  assert.throws(
    () => parseProjectManifest(`schema_version = 1
[project]
id = "ok"
`, join(dir, "m.toml")),
    /project\.database/,
  );
});

test("manifest: rejects duplicate names, duplicate enabled sources, and duplicate canonical paths", () => {
  const dir = tmpDir();
  mkdirSync(join(dir, "a"), { recursive: true });
  mkdirSync(join(dir, "b"), { recursive: true });
  const base = `schema_version = 1\n[project]\nid = "x"\ndatabase = "d"\n`;

  assert.throws(
    () => parseProjectManifest(`${base}
[[repositories]]
name = "dup"
path = "a"
[[repositories]]
name = "dup"
path = "b"
`, join(dir, "m.toml")),
    /duplicate repository name/,
  );

  assert.throws(
    () => parseProjectManifest(`${base}
[[repositories]]
name = "a"
path = "a"
source = "same"
[[repositories]]
name = "b"
path = "b"
source = "same"
`, join(dir, "m.toml")),
    /duplicate enabled source/,
  );

  // Two entries resolving to the same canonical path (`.` and `./a/..`).
  assert.throws(
    () => parseProjectManifest(`${base}
[[repositories]]
name = "a"
path = "."
[[repositories]]
name = "b"
path = "./a/.."
`, join(dir, "m.toml")),
    /same path/,
  );
});

test("manifest: disabled entries are preserved and need not claim unique sources", () => {
  const dir = tmpDir();
  mkdirSync(join(dir, "app"), { recursive: true });
  mkdirSync(join(dir, "venv"), { recursive: true });
  const m = parseProjectManifest(`schema_version = 1
[project]
id = "x"
database = "d"
[[repositories]]
name = "app"
path = "app"
source = "shared"
index = true
[[repositories]]
name = "python-environment"
path = "venv"
source = "shared"
index = false
`, join(dir, "m.toml"));
  assert.equal(m.repositories.length, 2);
  assert.equal(m.repositories[1].index, false);
});

test("manifest: resolves symlinks consistently", () => {
  const dir = tmpDir();
  const real = join(dir, "real-repo");
  mkdirSync(real, { recursive: true });
  const link = join(dir, "link-repo");
  try {
    symlinkSync(real, link);
  } catch {
    // Symlinks may be unsupported (Windows without privileges) — skip.
    return;
  }
  const p = writeManifest(dir, `schema_version = 1
[project]
id = "x"
database = "d"
[[repositories]]
name = "a"
path = "link-repo"
`);
  const m = parseProjectManifest(`schema_version = 1
[project]
id = "x"
database = "d"
[[repositories]]
name = "a"
path = "link-repo"
`, p);
  const ctx = resolveProjectContext({
    env: { CODEGRAPH_PROJECT_FILE: p },
    cwd: dir,
    pluginDataDir: join(dir, "pd"),
    pluginRoot: join(dir, "plugin-bundle"),
  });
  assert.equal(ctx.repositories[0].path, realpathSync(real));
});

// ── Resolution precedence ─────────────────────────────────────────────────

test("resolve: explicit CODEGRAPH_PROJECT_FILE wins", () => {
  const dir = tmpDir();
  const p = writeManifest(dir, `schema_version = 1
[project]
id = "explicit"
database = ".codegraph/db.sqlite3"
`);
  const ctx = resolveProjectContext({
    env: { CODEGRAPH_PROJECT_FILE: p },
    cwd: join(dir, "elsewhere"),
    workspaceRoots: [{ uri: "file://" + dir }],
    pluginDataDir: join(dir, "pd"),
    pluginRoot: join(dir, "plugin-bundle"),
  });
  assert.equal(ctx.id, "explicit");
  assert.equal(ctx.discoverySource, "explicit");
  assert.equal(ctx.manifestPath, realpathSync(p));
  assert.equal(ctx.projectDir, realpathSync(dir));
  assert.ok(ctx.databasePath.endsWith(join(".codegraph", "db.sqlite3")));
  assert.ok(ctx.databasePath.startsWith(realpathSync(dir) + sep));
});

test("resolve: discovers one manifest from workspace roots", () => {
  const dir = tmpDir();
  const p = writeManifest(dir, `schema_version = 1
[project]
id = "from-roots"
database = "db.sqlite3"
`);
  const ctx = resolveProjectContext({
    env: {},
    cwd: join(dir, "other"),
    workspaceRoots: [{ uri: "file://" + dir }, { uri: "file://" + join(dir, "other") }],
    pluginDataDir: join(dir, "pd"),
    pluginRoot: join(dir, "plugin-bundle"),
  });
  assert.equal(ctx.id, "from-roots");
  assert.equal(ctx.discoverySource, "mcp-roots");
  assert.equal(ctx.databasePath, join(realpathSync(dir), "db.sqlite3"));
});

test("resolve: multiple discovered manifests are ambiguous", () => {
  const dir = tmpDir();
  const a = mkdirSync(join(dir, "a"), { recursive: true });
  const b = mkdirSync(join(dir, "b"), { recursive: true });
  writeFileSync(join(dir, "a", ".codegraph-project.toml"), `schema_version = 1\n[project]\nid = "a"\ndatabase = "d"\n`);
  writeFileSync(join(dir, "b", ".codegraph-project.toml"), `schema_version = 1\n[project]\nid = "b"\ndatabase = "d"\n`);
  assert.throws(
    () => resolveProjectContext({
      env: {},
      cwd: dir,
      workspaceRoots: [{ uri: "file://" + dir + "/a" }, { uri: "file://" + dir + "/b" }],
      pluginDataDir: join(dir, "pd"),
      pluginRoot: join(dir, "plugin-bundle"),
    }),
    /[Aa]mbiguous/,
  );
});

test("resolve: absolute SQLITE_PATH is honoured for compatibility", () => {
  const dir = tmpDir();
  const db = join(dir, "legacy.sqlite3");
  const ctx = resolveProjectContext({
    env: { SQLITE_PATH: db },
    cwd: join(dir, "work"),
    workspaceRoots: [{ uri: "file://" + join(dir, "work") }],
    pluginDataDir: join(dir, "pd"),
    pluginRoot: join(dir, "plugin-bundle"),
  });
  assert.equal(ctx.databasePath, realpathSync(dirname(db)) + sep + "legacy.sqlite3");
  assert.equal(ctx.discoverySource, "absolute-sqlite");
  assert.equal(ctx.id.startsWith("legacy-"), true);
});

test("resolve: fallback keyed on canonical roots, order-independent", () => {
  const dir = tmpDir();
  const pd = join(dir, "pd");
  const r1 = { uri: "file://" + join(dir, "r1") };
  const r2 = { uri: "file://" + join(dir, "r2") };
  const ctxA = resolveProjectContext({ env: {}, cwd: dir, workspaceRoots: [r1, r2], pluginDataDir: pd, pluginRoot: join(dir, "plugin-bundle") });
  const ctxB = resolveProjectContext({ env: {}, cwd: dir, workspaceRoots: [r2, r1], pluginDataDir: pd, pluginRoot: join(dir, "plugin-bundle") });
  assert.equal(ctxA.databasePath, ctxB.databasePath);
  assert.equal(ctxA.id, ctxB.id);
  assert.equal(ctxA.discoverySource, "fallback");
  assert.match(ctxA.databasePath, new RegExp(`[\\\\/]projects[\\\\/][a-f0-9]{16}[\\\\/]codegraph\\.sqlite3$`));
});

test("workspaceFallbackKey is stable and order-independent", () => {
  const a = workspaceFallbackKey(["/x/a", "/x/b"]);
  const b = workspaceFallbackKey(["/x/b", "/x/a"]);
  assert.equal(a, b);
  assert.equal(a, workspaceFallbackKey(["/x/a", "/x/b"]));
  assert.notEqual(a, workspaceFallbackKey(["/x/a"]));
});

test("resolve: fallback canonicalizes, dedupes, and sorts roots for identity AND anchor", async () => {
  const dir = tmpDir();
  const pd = join(dir, "pd");
  const real = join(dir, "real-root");
  mkdirSync(real, { recursive: true });
  const link = join(dir, "link-root");
  let linked = false;
  try {
    symlinkSync(real, link);
    linked = true;
  } catch {
    // Symlinks unsupported — fall back to a duplicate-spelling assertion only.
  }

  const base = { env: {}, cwd: dir, pluginDataDir: pd, pluginRoot: join(dir, "plugin-bundle") } as const;
  const ctxA = resolveProjectContext({ ...base, workspaceRoots: [{ uri: "file://" + real }, { uri: "file://" + real }] });
  const ctxB = resolveProjectContext({ ...base, workspaceRoots: [{ uri: "file://" + real }, { uri: "file://" + real }] });
  assert.equal(ctxA.databasePath, ctxB.databasePath, "duplicate roots must not change identity");
  assert.equal(ctxA.projectDir, ctxB.projectDir, "duplicate roots must not change the anchor");

  if (linked) {
    const ctxLink = resolveProjectContext({ ...base, workspaceRoots: [{ uri: "file://" + link }] });
    assert.equal(ctxLink.databasePath, ctxA.databasePath, "a symlinked root must resolve to the same database");
    assert.equal(ctxLink.projectDir, ctxA.projectDir, "a symlinked root must resolve to the same anchor");
  }

  const ctxOrdered = resolveProjectContext({
    ...base,
    workspaceRoots: [{ uri: "file://" + real }, { uri: "file://" + join(dir, "z-root") }],
  });
  const ctxReordered = resolveProjectContext({
    ...base,
    workspaceRoots: [{ uri: "file://" + join(dir, "z-root") }, { uri: "file://" + real }],
  });
  assert.equal(ctxOrdered.databasePath, ctxReordered.databasePath);
  assert.equal(ctxOrdered.projectDir, ctxReordered.projectDir, "root order must not change the anchor dir");
});

// ── Plugin-bundle invariant ───────────────────────────────────────────────

test("isPathInside: path containment", () => {
  assert.equal(isPathInside("/a/b/c.sqlite3", "/a/b"), true);
  assert.equal(isPathInside("/a/b", "/a/b"), true);
  assert.equal(isPathInside("/a/bc/d.sqlite3", "/a/b"), false);
});

test("assertDatabaseOutsidePlugin rejects databases inside the plugin bundle", () => {
  const dir = tmpDir();
  const plugin = join(dir, "plugin");
  mkdirSync(join(dir, "plugin", "cache"), { recursive: true });
  assert.throws(
    () => assertDatabaseOutsidePlugin(join(plugin, "cache", "db.sqlite3"), plugin),
    /plugin bundle/,
  );
  assert.doesNotThrow(() => assertDatabaseOutsidePlugin(join(dir, "work", "db.sqlite3"), plugin));
});

test("resolve: rejects a manifest database inside the plugin bundle", () => {
  const dir = tmpDir();
  const plugin = join(dir, "plugin-bundle");
  const manifestDir = join(plugin, "some-project");
  mkdirSync(manifestDir, { recursive: true });
  const p = writeManifest(manifestDir, `schema_version = 1
[project]
id = "x"
database = ".codegraph/db.sqlite3"
`);
  assert.throws(
    () => resolveProjectContext({
      env: { CODEGRAPH_PROJECT_FILE: p },
      cwd: dir,
      pluginDataDir: join(dir, "pd"),
      pluginRoot: plugin,
    }),
    /plugin bundle/,
  );
});

test("resolve: missing repository produces a diagnostic but keeps read-only access", () => {
  const dir = tmpDir();
  const p = writeManifest(dir, `schema_version = 1
[project]
id = "x"
database = "db.sqlite3"
[[repositories]]
name = "gone"
path = "does-not-exist"
`);
  const ctx = resolveProjectContext({
    env: { CODEGRAPH_PROJECT_FILE: p },
    cwd: dir,
    pluginDataDir: join(dir, "pd"),
    pluginRoot: join(dir, "plugin-bundle"),
  });
  assert.equal(ctx.repositories.length, 1);
  assert.equal(ctx.repositories[0].exists, false);
  assert.ok(ctx.databasePath.endsWith("db.sqlite3"));
});

test("resolve: loadProjectManifest errors on missing file", () => {
  const dir = tmpDir();
  assert.throws(() => loadProjectManifest(join(dir, "nope.toml")), /not found/);
});

test("resolve: CODEGRAPH_PROJECT_FILE pointing at a missing file errors", () => {
  const dir = tmpDir();
  assert.throws(
    () => resolveProjectContext({
      env: { CODEGRAPH_PROJECT_FILE: join(dir, "missing.toml") },
      cwd: dir,
    }),
    ProjectError,
  );
});

// ── Repository metadata ───────────────────────────────────────────────────

test("context: repositories expose name/source/path/index/exists", () => {
  const dir = tmpDir();
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  const p = writeManifest(dir, `schema_version = 1
[project]
id = "x"
database = "db.sqlite3"
[[repositories]]
name = "app"
path = "repo"
source = "app-source"
`);
  const ctx = resolveProjectContext({
    env: { CODEGRAPH_PROJECT_FILE: p },
    cwd: dir,
    pluginDataDir: join(dir, "pd"),
    pluginRoot: join(dir, "plugin-bundle"),
  });
  assert.deepEqual(ctx.repositories[0], {
    name: "app",
    source: "app-source",
    path: realpathSync(repo),
    index: true,
    exists: true,
  });
});
