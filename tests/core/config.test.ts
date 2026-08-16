/**
 * Phase 1 unit tests — configuration precedence and storage-path selection.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  dataDir,
  defaultVenvDir,
  defaultConfigFile,
  resolveConfig,
} from "../../src/core/config.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "cg-core-"));
}

function touch(dir: string, rel: string): void {
  const p = join(dir, rel);
  mkdirSync(join(dir, dirname(rel)), { recursive: true });
  writeFileSync(p, "");
}

test("dataDir prefers PLUGIN_DATA over the Pi fallback", () => {
  const d = dataDir({ PLUGIN_DATA: "/tmp/plugin-data" } as NodeJS.ProcessEnv);
  assert.equal(d, "/tmp/plugin-data");
});

test("dataDir falls back to the Pi path (~/.pi/agent/codegraph)", () => {
  const d = dataDir({} as NodeJS.ProcessEnv);
  assert.match(d, /\.pi[\\/]agent[\\/]codegraph$/);
});

test("defaultVenvDir / defaultConfigFile derive from dataDir", () => {
  const env = { PLUGIN_DATA: "/tmp/pd" } as NodeJS.ProcessEnv;
  assert.equal(defaultVenvDir(env), "/tmp/pd/venv");
  assert.equal(defaultConfigFile(env), "/tmp/pd/config.json");
});

test("config precedence: override beats env, cwd venv, config, bootstrapped venv, python3", () => {
  const dir = tmpDir();
  const env = {
    PLUGIN_DATA: join(dir, "pd"),
    CODEGRAPH_PYTHON: "/env/python",
  } as NodeJS.ProcessEnv;
  // Also make cwd venv + bootstrapped venv present to prove override wins.
  touch(dir, ".venv/bin/python");
  touch(join(dir, "pd"), "venv/pyvenv.cfg");
  touch(join(dir, "pd"), "venv/bin/python");

  const c = resolveConfig({ python: "/override/python" }, env, dir);
  assert.equal(c.python, "/override/python");
  assert.equal(c.pythonSource, "flag(override)");
});

test("config precedence: env beats cwd venv, config, bootstrapped venv", () => {
  const dir = tmpDir();
  const env = {
    PLUGIN_DATA: join(dir, "pd"),
    CODEGRAPH_PYTHON: "/env/python",
  } as NodeJS.ProcessEnv;
  touch(dir, ".venv/bin/python");
  touch(join(dir, "pd"), "venv/pyvenv.cfg");

  const c = resolveConfig({}, env, dir);
  assert.equal(c.python, "/env/python");
  assert.equal(c.pythonSource, "$CODEGRAPH_PYTHON");
});

test("config precedence: cwd .venv beats persisted config and bootstrapped venv", () => {
  const dir = tmpDir();
  const env = { PLUGIN_DATA: join(dir, "pd") } as NodeJS.ProcessEnv;
  touch(dir, ".venv/bin/python");
  touch(join(dir, "pd"), "venv/pyvenv.cfg");
  writeFileSync(join(dir, "pd", "config.json"), JSON.stringify({ python: "/cfg/python" }));

  const c = resolveConfig({}, env, dir);
  assert.equal(c.python, join(dir, ".venv", "bin", "python"));
  assert.equal(c.pythonSource, "cwd(.venv)");
});

test("config precedence: persisted config beats bootstrapped venv", () => {
  const dir = tmpDir();
  const env = { PLUGIN_DATA: join(dir, "pd") } as NodeJS.ProcessEnv;
  touch(join(dir, "pd"), "venv/pyvenv.cfg");
  writeFileSync(join(dir, "pd", "config.json"), JSON.stringify({ python: "/cfg/python" }));

  const c = resolveConfig({}, env, dir);
  assert.equal(c.python, "/cfg/python");
  assert.equal(c.pythonSource, `config(${join(dir, "pd", "config.json")})`);
});

test("config precedence: bootstrapped venv beats python3 fallback", () => {
  const dir = tmpDir();
  const env = { PLUGIN_DATA: join(dir, "pd") } as NodeJS.ProcessEnv;
  touch(join(dir, "pd"), "venv/pyvenv.cfg");
  touch(join(dir, "pd"), "venv/bin/python");

  const c = resolveConfig({}, env, dir);
  assert.equal(c.python, join(dir, "pd", "venv", "bin", "python"));
  assert.equal(c.pythonSource, `venv(${join(dir, "pd", "venv", "bin", "python")})`);
});

test("config precedence: python3 fallback when nothing else present", () => {
  const dir = tmpDir();
  const env = { PLUGIN_DATA: join(dir, "pd") } as NodeJS.ProcessEnv;
  const c = resolveConfig({}, env, dir);
  assert.equal(c.python, "python3");
  assert.equal(c.pythonSource, "python3 (fallback)");
});

test("config: CODEGRAPH_VENV env overrides default venv dir", () => {
  const env = { CODEGRAPH_VENV: "/custom/venv" } as NodeJS.ProcessEnv;
  const c = resolveConfig({}, env, "/whatever");
  assert.equal(c.venvDir, "/custom/venv");
});

test("config: override venvDir wins over env", () => {
  const env = { CODEGRAPH_VENV: "/custom/venv" } as NodeJS.ProcessEnv;
  const c = resolveConfig({ venvDir: "/override/venv" }, env, "/whatever");
  assert.equal(c.venvDir, "/override/venv");
});

test("config: bridge path from flag override, env, then DEFAULT_BRIDGE", () => {
  const env = { CODEGRAPH_BRIDGE: "/env/bridge.py" } as NodeJS.ProcessEnv;
  assert.equal(resolveConfig({ bridgePath: "/flag/bridge.py" }, env).bridgePath, "/flag/bridge.py");
  assert.equal(resolveConfig({}, env).bridgePath, "/env/bridge.py");
  const c = resolveConfig({}, {});
  assert.ok(existsSync(c.bridgePath), `DEFAULT_BRIDGE should exist: ${c.bridgePath}`);
  assert.match(c.bridgePath, /bridge[\\/]codegraph_bridge\.py$/);
});

test("config: source specs from override, env, then defaults", () => {
  const env = {
    CODEGRAPH_SOURCE: "/env/codegraph",
    DOXYGEN_INDEX_SOURCE: "/env/doxygen-index",
  } as NodeJS.ProcessEnv;
  const c = resolveConfig({ codegraphSource: "/flag/cg" }, env);
  assert.equal(c.codegraphSource, "/flag/cg");
  assert.equal(c.doxygenIndexSource, "/env/doxygen-index");
  const d = resolveConfig({}, {});
  assert.equal(d.codegraphSource, "codegraph");
  assert.equal(d.doxygenIndexSource, "doxygen-index");
});
