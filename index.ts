/**
 * codegraph — Pi extension wrapping the codegraph knowledge-graph library.
 *
 * Provides a 9-tool surface for codebase knowledge-graph retrieval,
 * interactive visualization, setup/indexing, requirements discovery,
 * HLR decomposition, OO design, and design-memory management.
 *
 *   codegraph_query   — fetch a scoped subgraph as markdown / plantuml / json
 *                       / html, with a `scope` discriminator.
 *   codegraph_explore — lightweight lookups returning slim JSON.
 *   codegraph_tests   — test-focused exploration.
 *   codegraph_stats   — compact high-level statistics.
 *   codegraph_setup   — bootstrap env, config, indexing, Neo4j/Docker.
 *   codegraph_discover — discover existing requirements before designing.
 *   codegraph_decompose — decompose HLR → LLRs with verification stubs.
 *   codegraph_design   — OO class design, resolve verification stubs.
 *   codegraph_memory   — design memory: decisions, constraints, rationale.
 *
 * A long-lived Python sidecar (`bridge/codegraph_bridge.py`) holds a single
 * `CodeGraphDispatcher` (with its cached `current_graph`) for the session.
 *
 * Flags:
 *   --codegraph-python   Python interpreter (default: $CODEGRAPH_PYTHON or python3)
 *   --codegraph-bridge   Path to the bridge script
 *   --codegraph-venv     Venv path
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CodegraphBridge, ok, err, tail, openPath,
  DEFAULT_BRIDGE, DEFAULT_VENV, CONFIG_DIR, CONFIG_FILE,
  SETUP_TIMEOUT_MS, WIN,
} from "./shared.js";

// ── Tool modules ───────────────────────────────────────────────────────────
import { registerQueryTool } from "./tools/query.js";
import { registerExploreTool } from "./tools/explore.js";
import { registerTestsTool } from "./tools/tests.js";
import { registerStatsTool } from "./tools/stats.js";
import { registerSetupTool } from "./tools/setup.js";
import { registerDiscoverTool } from "./tools/discover.js";
import { registerDecomposeTool } from "./tools/decompose.js";
import { registerDesignTool } from "./tools/design.js";
import { registerMemoryTool } from "./tools/memory.js";

// ── Extension entry point ──────────────────────────────────────────────────

export default function codegraphExtension(pi: ExtensionAPI): void {
  // ── Flags ────────────────────────────────────────────────────────────────
  pi.registerFlag("codegraph-python", {
    description: "Python interpreter used to run the codegraph bridge. Precedence: this flag > $CODEGRAPH_PYTHON > /codegraph python <path> (persisted in ~/.pi/agent/codegraph/config.json) > bootstrapped venv > python3.",
    type: "string",
  });
  pi.registerFlag("codegraph-bridge", {
    description: "Path to the codegraph bridge script",
    type: "string",
    default: DEFAULT_BRIDGE,
  });
  pi.registerFlag("codegraph-venv", {
    description: "Path to the auto-provisioned Python venv (created by codegraph_setup action='bootstrap_env'). Default: ~/.pi/agent/codegraph/venv",
    type: "string",
    default: DEFAULT_VENV,
  });
  pi.registerFlag("codegraph-python-base", {
    description: "Base Python interpreter used to create the bootstrapped venv (default: $CODEGRAPH_PYTHON_BASE or python3)",
    type: "string",
    default: process.env.CODEGRAPH_PYTHON_BASE || "python3",
  });
  pi.registerFlag("codegraph-source", {
    description: "pip install spec or local path for the codegraph package (default: 'codegraph'). Pass a path for an editable install.",
    type: "string",
    default: process.env.CODEGRAPH_SOURCE || "codegraph",
  });
  pi.registerFlag("doxygen-index-source", {
    description: "pip install spec or local path for the doxygen-index package (default: 'doxygen-index'). Pass a path for an editable install.",
    type: "string",
    default: process.env.DOXYGEN_INDEX_SOURCE || "doxygen-index",
  });
  pi.registerFlag("codegraph-steer-reads", {
    description: "Opt-in steering: block the first source-code `read` of each distinct path until a codegraph_* tool has been used, returning a steering reason. Session-scoped: each path is blocked at most once, steering stops once any codegraph tool is used, hard cap of 8 blocks/session (no infinite loops). off by default.",
    type: "boolean",
    default: false,
  });


  // ── Venv / interpreter resolution ────────────────────────────────────────
  function venvDir(): string {
    const f = pi.getFlag("codegraph-venv");
    return (typeof f === "string" && f.trim()) ? f : DEFAULT_VENV;
  }
  function venvBin(name: string): string {
    return join(venvDir(), WIN ? "Scripts" : "bin", WIN ? `${name}.exe` : name);
  }
  function venvPython(): string { return venvBin("python"); }
  function venvExists(): boolean { return existsSync(join(venvDir(), "pyvenv.cfg")); }

  interface CgConfig { python?: string }
  function readConfig(): CgConfig {
    try {
      const raw = readFileSync(CONFIG_FILE, "utf8");
      const obj = JSON.parse(raw);
      return (obj && typeof obj === "object") ? obj as CgConfig : {};
    } catch { return {}; }
  }
  function writeConfig(patch: CgConfig): void {
    try {
      mkdirSync(CONFIG_DIR, { recursive: true });
      const cur = readConfig();
      writeFileSync(CONFIG_FILE, JSON.stringify({ ...cur, ...patch }, null, 2) + "\n");
    } catch { /* best-effort */ }
  }

  function cwdVenvPython(): string | null {
    const venv = join(process.cwd(), ".venv", WIN ? "Scripts" : "bin", WIN ? "python.exe" : "python");
    if (existsSync(venv)) return venv;
    return null;
  }

  function pythonSource(): string {
    const f = pi.getFlag("codegraph-python");
    if (typeof f === "string" && f.trim()) return `flag(--codegraph-python)`;
    if (process.env.CODEGRAPH_PYTHON) return "$CODEGRAPH_PYTHON";
    if (cwdVenvPython()) return `cwd(.venv)`;
    const cfg = readConfig().python;
    if (cfg && cfg.trim()) return `config(${CONFIG_FILE})`;
    if (venvExists()) return `venv(${venvPython()})`;
    return "python3 (fallback)";
  }

  function resolvePython(): string {
    // 1. Explicit flag
    const f = pi.getFlag("codegraph-python");
    if (typeof f === "string" && f.trim()) return f;
    // 2. Environment variable
    if (process.env.CODEGRAPH_PYTHON) return process.env.CODEGRAPH_PYTHON;
    // 3. Project-local venv (auto-detect from CWD)
    const cwdVenv = cwdVenvPython();
    if (cwdVenv) return cwdVenv;
    // 4. Persisted config
    const cfg = readConfig().python;
    if (cfg && cfg.trim()) return cfg;
    // 5. Bootstrapped venv
    if (venvExists()) return venvPython();
    // 6. System fallback
    return "python3";
  }

  /** Load env vars from a .env file (simple KEY=VALUE parser, no shell expansion). */
  function loadEnvFile(path: string): Record<string, string> {
    const vars: Record<string, string> = {};
    try {
      const content = readFileSync(path, "utf8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq < 0) continue;
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        // Strip surrounding quotes
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        vars[key] = val;
      }
    } catch { /* .env not found or unreadable — no-op */ }
    return vars;
  }
  function resolveBridgePath(): string {
    const f = pi.getFlag("codegraph-bridge");
    if (typeof f === "string" && f.trim()) return f;
    return DEFAULT_BRIDGE;
  }
  function resolveBasePython(): string {
    const f = pi.getFlag("codegraph-python-base");
    if (typeof f === "string" && f.trim()) return f;
    return process.env.CODEGRAPH_PYTHON_BASE || "python3";
  }
  function resolveSource(flagName: string, fallback: string): string {
    const f = pi.getFlag(flagName);
    return (typeof f === "string" && f.trim()) ? f : fallback;
  }

  let bridge: CodegraphBridge | null = null;

  async function ensureBridge(): Promise<CodegraphBridge> {
    if (bridge && bridge.isRunning()) return bridge;
    if (!bridge) {
      // Load .env from project directory before spawning the bridge.
      // The bridge inherits process.env; we merge .env vars so Neo4j
      // credentials and other project config are available.
      const projectEnv = loadEnvFile(join(process.cwd(), ".env"));
      bridge = new CodegraphBridge(resolvePython(), resolveBridgePath(), projectEnv);
    }
    await bridge.start();
    return bridge;
  }

  // ── bootstrap_env: auto-provision a venv ─────────────────────────────────
  function pipSpec(flagName: string, fallback: string): string[] {
    const s = resolveSource(flagName, fallback);
    if (existsSync(s)) return ["-e", s];
    return [s];
  }

  async function bootstrapEnv(params: Record<string, unknown>): Promise<ReturnType<typeof ok> | ReturnType<typeof err>> {
    const dir = venvDir();
    const pyExe = venvPython();
    const pipExe = venvBin("pip");
    const base = resolveBasePython();
    const steps: Array<Record<string, unknown>> = [];
    const codegraphSpec = (params.codegraph_source as string | undefined)
      ?? resolveSource("codegraph-source", "codegraph");
    const doxySpec = (params.doxygen_index_source as string | undefined)
      ?? resolveSource("doxygen-index-source", "doxygen-index");
    const cgArgs = existsSync(codegraphSpec) ? ["-e", codegraphSpec] : [codegraphSpec];
    const dxArgs = existsSync(doxySpec) ? ["-e", doxySpec] : [doxySpec];

    if (!venvExists()) {
      const r = await pi.exec(base, ["-m", "venv", "--upgrade-deps", dir],
        { timeout: 180_000 });
      steps.push({ step: "venv_create", exit_code: r.code, killed: r.killed, stderr: tail(r.stderr) });
      if (r.code !== 0) {
        return err(`Failed to create venv at ${dir} (using ${base}): ${r.stderr || 'exit ' + r.code}`,
          { venv_path: dir, steps });
      }
    } else {
      steps.push({ step: "venv_create", skipped: true, venv_path: dir });
    }

    const installArgs = ["install", "-U", ...cgArgs, ...dxArgs];
    const r2 = await pi.exec(pipExe, installArgs, { timeout: SETUP_TIMEOUT_MS });
    steps.push({ step: "pip_install", exit_code: r2.code, killed: r2.killed,
      stdout: tail(r2.stdout), stderr: tail(r2.stderr) });
    if (r2.code !== 0) {
      return err(`pip install failed (exit ${r2.code}): ${tail(r2.stderr) || tail(r2.stdout)}`,
        { venv_path: dir, steps, install_args: installArgs });
    }

    const r3 = await pi.exec(pyExe,
      ["-c", "import codegraph, doxygen_index; print(getattr(codegraph,'__version__','?'))"],
      { timeout: 30_000 });
    const verified = r3.code === 0;
    steps.push({ step: "verify_import", exit_code: r3.code, stdout: tail(r3.stdout), stderr: tail(r3.stderr) });

    await bridge?.stop().catch(() => {});
    bridge = null;

    const version = (r3.stdout || "").trim() || "unknown";
    const msg = `Bootstrapped codegraph venv at ${dir} (python ${pyExe}) — codegraph ${version}, import ${verified ? "OK" : "FAILED"}`;
    return ok(msg, { venv_path: dir, python: pyExe, codegraph_version: version, verified, steps });
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────
  pi.on("session_start", () => {
    const prev = bridge;
    const projectEnv = loadEnvFile(join(process.cwd(), ".env"));
    bridge = new CodegraphBridge(resolvePython(), resolveBridgePath(), projectEnv);
    void prev?.stop().catch(() => {});
    steerUsedCodegraph = false;
    steerBlockedPaths.clear();
    steerBlockCount = 0;
  });

  pi.on("session_shutdown", () => {
    const b = bridge;
    bridge = null;
    void b?.stop().catch(() => {});
  });

  // ── Read steering ────────────────────────────────────────────────────────
  let steerUsedCodegraph = false;
  const steerBlockedPaths = new Set<string>();
  let steerBlockCount = 0;
  const STEER_CAP = 8;
  const SOURCE_EXT = /\.(py|ts|tsx|js|jsx|mjs|cjs|cpp|c|cc|h|hpp|hh|rs|go|java|kt|swift|rb|php|cs|scala|clj|ex|exs|erl|hs|ml|fs|vue|svelte|dart|lua|pl|pm|r|jl|zig|nim|v|cr)\b/i;
  const SOURCE_SEG = /(^|[\\/])(src|lib|libs|app|internal|pkg|cmd|api|core|services|components|modules|packages)([\\/]|$)/;
  const looksLikeSource = (p: string): boolean => SOURCE_EXT.test(p) || SOURCE_SEG.test(p);
  const STEER_REASON =
    "This repository is indexed in a codegraph knowledge graph (Neo4j). " +
    "Before reading source files to understand structure, call graphs, or " +
    "class/method relationships, first call codegraph_explore (action: search/compound/member/callers_callees/inheritance) " +
    "and/or codegraph_query (scope: neighborhood, format: markdown) to retrieve graph context, " +
    "then read files for implementation detail. Re-issue this read afterward. " +
    "(Disable with --no-codegraph-steer-reads or `pi ... -o codegraph-steer-reads=false`.)";

  pi.on("tool_call", (event) => {
    if (typeof event.toolName === "string" && event.toolName.startsWith("codegraph_")) {
      steerUsedCodegraph = true;
      return;
    }
    const steerRaw = pi.getFlag("codegraph-steer-reads");
    const steerOn = steerRaw === true || steerRaw === "true" || steerRaw === "1";
    if (!steerOn) return;
    if (event.toolName !== "read") return;
    if (steerUsedCodegraph) return;
    const path = (event.input as { path?: string } | undefined)?.path;
    if (typeof path !== "string" || !looksLikeSource(path)) return;
    if (steerBlockedPaths.has(path) || steerBlockCount >= STEER_CAP) return;
    steerBlockedPaths.add(path);
    steerBlockCount += 1;
    process.stderr.write(`[codegraph-steer] blocked first source read of ${path} this session — steering to codegraph_* tools (${steerBlockCount}/${STEER_CAP})\n`);
    return { block: true, reason: STEER_REASON };
  });

  // ── Register tools ───────────────────────────────────────────────────────
  const bridgeDeps = { ensureBridge };
  registerQueryTool(pi, bridgeDeps);
  registerExploreTool(pi, bridgeDeps);
  registerTestsTool(pi, bridgeDeps);
  registerStatsTool(pi, bridgeDeps);
  registerSetupTool(pi, { ensureBridge, bootstrapEnv });
  registerDiscoverTool(pi, bridgeDeps);
  registerDecomposeTool(pi, bridgeDeps);
  registerDesignTool(pi, bridgeDeps);
  registerMemoryTool(pi, bridgeDeps);

  // ── /codegraph command ───────────────────────────────────────────────────
  pi.registerCommand("codegraph", {
    description: "codegraph extension: status | restart | bootstrap | python | bridge | venv",
    handler: async (args, ctx) => {
      const parts = args?.trim().split(/\s+/) ?? [];
      const sub = (parts[0] ?? "status").toLowerCase();
      const rest = parts.slice(1).join(" ");

      if (sub === "venv") {
        console.log(`codegraph venv: ${venvDir()} (${venvExists() ? "present" : "missing"})`);
        console.log(`  python: ${venvPython()}`);
        return;
      }
      if (sub === "bootstrap") {
        const p: Record<string, unknown> = { action: "bootstrap_env" };
        if (parts[1]) p.codegraph_source = parts[1];
        if (parts[2]) p.doxygen_index_source = parts[2];
        const r = await bootstrapEnv(p);
        const line = r.content[0]?.text ?? "";
        const isError = "isError" in r && r.isError === true;
        if (ctx.hasUI) ctx.ui.notify(line, isError ? "error" : "info");
        else console.log(line);
        return;
      }
      if (sub === "restart") {
        const prev = bridge;
        bridge = new CodegraphBridge(resolvePython(), resolveBridgePath());
        await prev?.stop().catch(() => {});
        try {
          await ensureBridge();
          if (ctx.hasUI) ctx.ui.notify("codegraph bridge restarted", "info");
          else console.log("codegraph bridge restarted");
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (ctx.hasUI) ctx.ui.notify(`codegraph restart failed: ${msg}`, "error");
          else console.error(`codegraph restart failed: ${msg}`);
        }
        return;
      }
      if (sub === "python") {
        if (parts[1] === "--clear" || parts[1] === "-c") {
          writeConfig({ python: undefined as unknown as string });
          console.log(`codegraph: cleared persisted python (was config file ${CONFIG_FILE})`);
          console.log(`  now: ${resolvePython()}  (source: ${pythonSource()})`);
          return;
        }
        const p = parts.slice(1).join("").trim();
        if (p) {
          if (!existsSync(p)) {
            console.error(`codegraph python: not found — ${p}`);
            return;
          }
          writeConfig({ python: p });
          console.log(`codegraph: persisted python = ${p}`);
          console.log(`  config: ${CONFIG_FILE}`);
          console.log(`  resolved: ${resolvePython()}  (source: ${pythonSource()})`);
          console.log(`  (restart pi, or /codegraph restart, to relaunch the bridge under it)`);
          return;
        }
        const cfg = readConfig().python;
        console.log(`codegraph python: ${resolvePython()}`);
        console.log(`  source: ${pythonSource()}`);
        if (cfg && cfg.trim()) console.log(`  config: ${cfg}  (${CONFIG_FILE})`);
        else console.log(`  config: (not set — run: /codegraph python <path> to persist)`);
        return;
      }
      if (sub === "bridge") {
        console.log(`codegraph bridge: ${resolveBridgePath()}`);
        return;
      }
      void rest;
      try {
        const b = await ensureBridge();
        const res = await b.call("ping", {}, 15_000);
        if (res.ok) {
          const ping = res.result as { ok?: boolean; version?: string; error?: string } | undefined;
          const line = ping?.ok
            ? `codegraph: ready (version ${ping.version ?? "?"}, python ${resolvePython()})`
            : `codegraph: bridge up but codegraph unavailable: ${ping?.error ?? "?"}`;
          if (ctx.hasUI) ctx.ui.notify(line, ping?.ok ? "info" : "warning");
          else console.log(line);
        } else {
          if (ctx.hasUI) ctx.ui.notify(`codegraph: ping failed — ${res.error}`, "error");
          else console.error(`codegraph: ping failed — ${res.error}`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (ctx.hasUI) ctx.ui.notify(`codegraph: not started — ${msg}`, "error");
        else console.error(`codegraph: not started — ${msg}`);
      }
    },
  });
}
