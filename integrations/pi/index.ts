/**
 * codegraph — Pi extension wrapping the codegraph knowledge-graph library.
 *
 * Provides a 9-tool surface for codebase knowledge-graph retrieval,
 * interactive visualization, setup/indexing, requirements discovery,
 * HLR decomposition, OO design, and design-memory management.
 *
 * This entry point is the Pi harness: it registers flags, the
 * `/codegraph` command, read steering, and wires the tools to the
 * host-neutral CodegraphRuntime (src/core/runtime.ts).
 *
 * Flags:
 *   --codegraph-python   Python interpreter (default: $CODEGRAPH_PYTHON or python3)
 *   --codegraph-bridge   Path to the bridge script
 *   --codegraph-venv     Venv path
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import {
  DEFAULT_VENV, CONFIG_FILE,
} from "./shared.js";
import { CodegraphRuntime } from "../../src/core/runtime.js";
import { resolveConfig, type ConfigOverrides } from "../../src/core/config.js";

// ── Tool modules ───────────────────────────────────────────────────────────
import { registerQueryTool } from "../../tools/query.js";
import { registerExploreTool } from "../../tools/explore.js";
import { registerTestsTool } from "../../tools/tests.js";
import { registerStatsTool } from "../../tools/stats.js";
import { registerSetupTool } from "../../tools/setup.js";
import { registerDiscoverTool } from "../../tools/discover.js";
import { registerDecomposeTool } from "../../tools/decompose.js";
import { registerDesignTool } from "../../tools/design.js";
import { registerMemoryTool } from "../../tools/memory.js";

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
    default: resolveConfig({}, process.env).bridgePath,
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

  // ── Runtime construction ────────────────────────────────────────────────
  // The flags are read once per session; the runtime is rebuilt on
  // session_start so a changed config/.env is picked up.

  function flagStr(name: string): string | undefined {
    const v = pi.getFlag(name);
    return (typeof v === "string" && v.trim()) ? v : undefined;
  }

  function buildRuntime(): CodegraphRuntime {
    const overrides: ConfigOverrides = {
      python: flagStr("codegraph-python"),
      bridgePath: flagStr("codegraph-bridge"),
      venvDir: flagStr("codegraph-venv"),
      pythonBase: flagStr("codegraph-python-base"),
      codegraphSource: flagStr("codegraph-source"),
      doxygenIndexSource: flagStr("doxygen-index-source"),
    };
    return new CodegraphRuntime(resolveConfig(overrides, process.env, process.cwd()));
  }

  let runtime: CodegraphRuntime = buildRuntime();

  // ── Lifecycle ────────────────────────────────────────────────────────────
  pi.on("session_start", () => {
    const prev = runtime;
    runtime = buildRuntime();
    void prev.stopBridge().catch(() => {});
    steerUsedCodegraph = false;
    steerBlockedPaths.clear();
    steerBlockCount = 0;
  });

  pi.on("session_shutdown", () => {
    void runtime.stopBridge().catch(() => {});
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
    "This repository is indexed in a codegraph knowledge graph. " +
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

  // ── Register tools (Pi wrappers adapt catalog definitions) ─────────────
  registerQueryTool(pi, runtime);
  registerExploreTool(pi, runtime);
  registerTestsTool(pi, runtime);
  registerStatsTool(pi, runtime);
  registerSetupTool(pi, runtime);
  registerDiscoverTool(pi, runtime);
  registerDecomposeTool(pi, runtime);
  registerDesignTool(pi, runtime);
  registerMemoryTool(pi, runtime);

  // ── /codegraph command ───────────────────────────────────────────────────
  pi.registerCommand("codegraph", {
    description: "codegraph extension: status | restart | bootstrap | python | bridge | venv",
    handler: async (args, ctx) => {
      const parts = args?.trim().split(/\s+/) ?? [];
      const sub = (parts[0] ?? "status").toLowerCase();
      const rest = parts.slice(1).join(" ");

      if (sub === "venv") {
        const info = runtime.venvInfo();
        console.log(`codegraph venv: ${info.dir} (${info.present ? "present" : "missing"})`);
        console.log(`  python: ${info.python}`);
        return;
      }
      if (sub === "bootstrap") {
        const p: Record<string, unknown> = { action: "bootstrap_env" };
        if (parts[1]) p.codegraph_source = parts[1];
        if (parts[2]) p.doxygen_index_source = parts[2];
        const r = await runtime.bootstrapEnv(p);
        const line = r.text;
        const isError = !r.ok;
        if (ctx.hasUI) ctx.ui.notify(line, isError ? "error" : "info");
        else console.log(line);
        return;
      }
      if (sub === "restart") {
        try {
          await runtime.restartBridge();
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
          runtime.clearPersistedPython();
          console.log(`codegraph: cleared persisted python (was config file ${CONFIG_FILE})`);
          console.log(`  now: ${runtime.config.python}  (source: ${runtime.config.pythonSource})`);
          return;
        }
        const p = parts.slice(1).join("").trim();
        if (p) {
          if (!existsSync(p)) {
            console.error(`codegraph python: not found — ${p}`);
            return;
          }
          runtime.persistPython(p);
          const fresh = buildRuntime();
          console.log(`codegraph: persisted python = ${p}`);
          console.log(`  config: ${CONFIG_FILE}`);
          console.log(`  resolved: ${fresh.config.python}  (source: ${fresh.config.pythonSource})`);
          console.log(`  (restart pi, or /codegraph restart, to relaunch the bridge under it)`);
          return;
        }
        console.log(`codegraph python: ${runtime.config.python}`);
        console.log(`  source: ${runtime.config.pythonSource}`);
        const cfg = runtime.persistedPython();
        if (cfg && cfg.trim()) console.log(`  config: ${cfg}  (${CONFIG_FILE})`);
        else console.log(`  config: (not set — run: /codegraph python <path> to persist)`);
        return;
      }
      if (sub === "bridge") {
        console.log(`codegraph bridge: ${runtime.config.bridgePath}`);
        return;
      }
      void rest;
      try {
        const res = await runtime.ping();
        if (res.ok) {
          const ping = res.result as { ok?: boolean; version?: string; error?: string } | undefined;
          const line = ping?.ok
            ? `codegraph: ready (version ${ping.version ?? "?"}, python ${runtime.config.python})`
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
