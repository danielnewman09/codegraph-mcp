// Runtime smoke test: load the extension via a stub ExtensionAPI and exercise
// all three tools end-to-end through the real Python bridge.
// Self-terminating + per-call timeouts so it can never hang.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const log = (...a: unknown[]) => console.error("[stub]", ...a);
const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

type Tool = {
  name: string;
  parameters: unknown;
  execute: (id: string, params: any, signal?: AbortSignal) => Promise<any>;
};
const tools = new Map<string, Tool>();
const flags = new Map<string, any>();

const pi: any = {
  registerTool: (t: Tool) => { tools.set(t.name, t); },
  registerCommand: () => {},
  registerFlag: (n: string, o: any) => { flags.set(n, o.default); },
  getFlag: (n: string) => flags.get(n),
  on: () => {},
  exec: (cmd: string, args: string[]) =>
    new Promise((resolve) => {
      const p = spawn(cmd, args, { stdio: "ignore" });
      p.on("exit", (code) => resolve({ code, stdout: "", stderr: "" }));
      p.on("error", () => resolve({ code: 1, stdout: "", stderr: "" }));
    }),
};

log("importing extension…");
const mod = await import("./index.ts");
mod.default(pi);
log("flags:", [...flags.keys()]);
log("tools:", [...tools.keys()]);

// Use the venv python that has codegraph installed.
flags.set("codegraph-python", "/Users/danielnewman/dev/.venv/bin/python");

const explore = tools.get("codegraph_explore")!;
const query = tools.get("codegraph_query")!;
const setup = tools.get("codegraph_setup")!;

async function run(label: string, fn: () => Promise<any>, ms = 30_000) {
  log(`→ ${label} @ ${elapsed()}`);
  try {
    const r = await withTimeout(fn(), ms, label);
    const text = r?.content?.[0]?.text ?? "(no text)";
    log(`✓ ${label} @ ${elapsed()} (${text.length} chars)`);
    return text;
  } catch (e) {
    log(`✗ ${label} @ ${elapsed()}: ${(e as Error).message}`);
    throw e;
  }
}

try {
  const t1 = await run("explore tags", () => explore.execute("t1", { action: "tags" }));
  console.log("\n=== explore tags ===\n" + t1);

  const t2 = await run("explore search", () => explore.execute("t2", { action: "search", query: "LayerGraph", limit: 2 }));
  console.log("\n=== explore search ===\n" + t2);

  const t3 = await run("query neighborhood html", () =>
    query.execute("t3", { scope: "neighborhood", qualified_name: "codegraph.graph.LayerGraph", format: "html", open: false }));
  console.log("\n=== query neighborhood html ===\n" + t3);

  const t4 = await run("query cached json", () => query.execute("t4", { scope: "cached", format: "json" }));
  console.log("\n=== query cached json (first 300 chars) ===\n" + t4.slice(0, 300));

  // ── setup tool ──
  const tmp = mkdtempSync(join(tmpdir(), "cg-setup-"));
  mkdirSync(join(tmp, "src", "pkg"), { recursive: true });
  mkdirSync(join(tmp, "tests"), { recursive: true });
  writeFileSync(join(tmp, "src", "pkg", "__init__.py"), "x=1");
  writeFileSync(join(tmp, "tests", "test_x.py"), "def t(): pass");
  writeFileSync(join(tmp, "pyproject.toml"), '[project]\nname = "synth-proj"\n');

  const t5 = await run("setup init_config", () => setup.execute("t5", { action: "init_config", project_dir: tmp, force: true }));
  console.log("\n=== setup init_config ===\n" + t5);

  const t6 = await run("setup status", () => setup.execute("t6", { action: "status" }));
  console.log("\n=== setup status (first 600) ===\n" + t6.slice(0, 600));

  const t7 = await run("setup db_status", () => setup.execute("t7", { action: "db_status", project_dir: tmp }));
  console.log("\n=== setup db_status (first 600) ===\n" + t7.slice(0, 600));

  log("ALL OK @", elapsed());
} catch (e) {
  log("FAILED @", elapsed(), (e as Error).message);
  process.exitCode = 1;
} finally {
  process.exit(process.exitCode ?? 0);
}