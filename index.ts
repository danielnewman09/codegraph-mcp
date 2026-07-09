/**
 * codegraph-mcp — Pi extension wrapping the codegraph knowledge-graph library.
 *
 * Provides a *narrow* 2-tool surface for efficient retrieval of codebase
 * graph context, plus an interactive HTML neighborhood visualiser.
 *
 *   codegraph_query   — fetch a scoped subgraph as markdown / plantuml / json
 *                       / html, with a `scope` discriminator that steers all
 *                       retrieval modes (tag, namespace, compound,
 *                       neighborhood, source, kind, cached).  Reuses the
 *                       cached LayerGraph so re-formatting and HTML rendering
 *                       are free after the first fetch.
 *   codegraph_explore — lightweight lookups (search, get_compound,
 *                       get_member, browse_namespace, list_sources,
 *                       list_tags, inheritance, callers/callees) returning
 *                       slim JSON — used to *find* symbols before fetching.
 *
 * A long-lived Python sidecar (`bridge/codegraph_bridge.py`) holds a single
 * `CodeGraphDispatcher` (with its cached `current_graph`) for the session,
 * so repeated fetches / re-exports / renders avoid re-initialising Neo4j.
 *
 * Flags:
 *   --codegraph-python   Python interpreter (default: $CODEGRAPH_PYTHON or python3)
 *   --codegraph-bridge   Path to the bridge script
 *                        (default: <extension>/bridge/codegraph_bridge.py)
 *
 * Neo4j connection uses env vars NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD,
 * inherited by the sidecar.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BRIDGE = join(__dirname, "bridge", "codegraph_bridge.py");
const DEFAULT_VENV = join(homedir(), ".pi", "agent", "codegraph-mcp", "venv");
const CONFIG_DIR = join(homedir(), ".pi", "agent", "codegraph-mcp");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const CALL_TIMEOUT_MS = 120_000; // Neo4j fetches can be slow on large graphs
const SETUP_TIMEOUT_MS = 600_000; // indexing / pip install can take minutes
const WIN = platform() === "win32";

// ── Bridge: stdio JSON-RPC client over a long-lived Python child ──────────

interface BridgeResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

class CodegraphBridge {
  private proc: ChildProcess | null = null;
  private seq = 0;
  private buffer = "";
  private pending = new Map<number, {
    resolve: (r: BridgeResponse) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private startPromise: Promise<void> | null = null;
  private dead = false;

  constructor(
    private readonly python: string,
    private readonly bridgePath: string,
  ) {}

  /** Whether the sidecar process is currently alive. */
  isRunning(): boolean {
    return !!this.proc && !this.dead;
  }

  /** Start the sidecar and run a ping health check. Idempotent if running. */
  async start(): Promise<void> {
    if (this.proc && !this.dead) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this._doStart();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async _doStart(): Promise<void> {
    this.dead = false;
    this.proc = spawn(this.python, [this.bridgePath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    this.proc.stdout?.setEncoding("utf8");
    this.proc.stdout?.on("data", (chunk: string) => this.onData(chunk));
    this.proc.stderr?.setEncoding("utf8");
    this.proc.stderr?.on("data", (chunk: string) => {
      // Diagnostics from Python / neomodel — never part of the framing channel.
      process.stderr.write(`[codegraph-bridge] ${chunk}`);
    });
    this.proc.on("exit", (code) => this.onExit(code));
    this.proc.on("error", (err) => {
      this.dead = true;
      this.failAll(err);
    });

    if (!this.proc.stdin || !this.proc.stdout) {
      throw new Error("Failed to open stdio pipes to codegraph bridge");
    }

    // Health check — surfaces a missing codegraph install / interpreter early.
    const res = await this.call("ping", {}, 15_000);
    if (!res.ok) {
      throw new Error(`codegraph bridge ping failed: ${res.error ?? "unknown"}`);
    }
    const ping = res.result as { ok?: boolean; error?: string; version?: string } | undefined;
    if (ping && ping.ok === false) {
      throw new Error(`codegraph not available: ${ping.error ?? "unknown"}`);
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: BridgeResponse;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // ignore non-JSON noise (shouldn't happen on stdout)
      }
      const entry = this.pending.get(msg.id);
      if (!entry) continue;
      clearTimeout(entry.timer);
      this.pending.delete(msg.id);
      entry.resolve(msg);
    }
  }

  private onExit(code: number | null): void {
    this.dead = true;
    this.proc = null;
    this.failAll(new Error(`codegraph bridge exited (code ${code})`));
  }

  private failAll(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  /** Send a request and await its correlated response. */
  call(method: string, params: Record<string, unknown>, timeoutMs = CALL_TIMEOUT_MS): Promise<BridgeResponse> {
    if (!this.proc || this.dead) {
      return Promise.reject(new Error("codegraph bridge is not running"));
    }
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codegraph '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const payload = JSON.stringify({ id, method, params }) + "\n";
      this.proc!.stdin!.write(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error(`failed to write to bridge: ${err.message}`));
        }
      });
    });
  }

  async stop(): Promise<void> {
    const p = this.proc;
    if (!p) return;
    this.proc = null;
    this.failAll(new Error("codegraph bridge stopped"));
    try {
      p.stdin?.end();
    } catch { /* ignore */ }
    const killer = setTimeout(() => {
      try { p.kill("SIGKILL"); } catch { /* ignore */ }
    }, 2000);
    p.once("exit", () => clearTimeout(killer));
    try { p.kill("SIGTERM"); } catch { /* ignore */ }
  }
}

// ── Cross-platform "open path" helper ──────────────────────────────────────

async function openPath(pi: ExtensionAPI, target: string): Promise<void> {
  const os = platform();
  let cmd: string;
  let args: string[];
  if (os === "darwin") { cmd = "open"; args = [target]; }
  else if (os === "win32") { cmd = "cmd"; args = ["/c", "start", "", target]; }
  else { cmd = "xdg-open"; args = [target]; }
  const result = await pi.exec(cmd, args);
  if (result.code !== 0) {
    throw new Error(result.stderr || `Failed to open ${target} (exit ${result.code})`);
  }
}

// ── Tool result helpers ────────────────────────────────────────────────────

function ok(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}
function err(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details, isError: true };
}
function tail(s: string, limit = 6000): string {
  if (!s) return "";
  return s.length <= limit ? s : "…(truncated)…\n" + s.slice(-limit);
}

// ── Extension entry point ──────────────────────────────────────────────────

export default function codegraphExtension(pi: ExtensionAPI): void {
  // Flags
  pi.registerFlag("codegraph-python", {
    description: "Python interpreter used to run the codegraph bridge. Precedence: this flag > $CODEGRAPH_PYTHON > /codegraph python <path> (persisted in ~/.pi/agent/codegraph-mcp/config.json) > bootstrapped venv > python3.",
    type: "string",
  });
  pi.registerFlag("codegraph-bridge", {
    description: "Path to the codegraph bridge script",
    type: "string",
    default: DEFAULT_BRIDGE,
  });
  pi.registerFlag("codegraph-venv", {
    description: "Path to the auto-provisioned Python venv (created by codegraph_setup action='bootstrap_env'). Default: ~/.pi/agent/codegraph-mcp/venv",
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

  let bridge: CodegraphBridge | null = null;

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

  // ── Persistent config (set once via /codegraph python <path>) ─────────────
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

  function pythonSource(): string {
    const f = pi.getFlag("codegraph-python");
    if (typeof f === "string" && f.trim()) return `flag(--codegraph-python)`;
    if (process.env.CODEGRAPH_PYTHON) return "$CODEGRAPH_PYTHON";
    const cfg = readConfig().python;
    if (cfg && cfg.trim()) return `config(${CONFIG_FILE})`;
    if (venvExists()) return `venv(${venvPython()})`;
    return "python3 (fallback)";
  }

  function resolvePython(): string {
    const f = pi.getFlag("codegraph-python");
    if (typeof f === "string" && f.trim()) return f;
    if (process.env.CODEGRAPH_PYTHON) return process.env.CODEGRAPH_PYTHON;
    const cfg = readConfig().python;
    if (cfg && cfg.trim()) return cfg;
    if (venvExists()) return venvPython();
    return "python3";
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

  async function ensureBridge(): Promise<CodegraphBridge> {
    if (bridge && bridge.isRunning()) return bridge;
    if (!bridge) {
      bridge = new CodegraphBridge(resolvePython(), resolveBridgePath());
    }
    // start() is safe to call repeatedly; it re-spawns if the process died.
    await bridge.start();
    return bridge;
  }

  // ── bootstrap_env: auto-provision a venv with codegraph + doxygen-index ──
  //
  // Done TypeScript-side (not via the bridge) because the bridge cannot run
  // until the venv + its packages exist.  After provisioning we tear down the
  // current bridge so the next call restarts it under the new venv python.
  function pipSpec(flagName: string, fallback: string): string[] {
    const s = resolveSource(flagName, fallback);
    // Editable install for local paths, plain spec for PyPI names / URLs.
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

    // 1. Create the venv if missing.
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

    // 2. Install / upgrade the two packages.
    const installArgs = ["install", "-U", ...cgArgs, ...dxArgs];
    const r2 = await pi.exec(pipExe, installArgs, { timeout: SETUP_TIMEOUT_MS });
    steps.push({ step: "pip_install", exit_code: r2.code, killed: r2.killed,
      stdout: tail(r2.stdout), stderr: tail(r2.stderr) });
    if (r2.code !== 0) {
      return err(`pip install failed (exit ${r2.code}): ${tail(r2.stderr) || tail(r2.stdout)}`,
        { venv_path: dir, steps, install_args: installArgs });
    }

    // 3. Verify both packages import.
    const r3 = await pi.exec(pyExe,
      ["-c", "import codegraph, doxygen_index; print(getattr(codegraph,'__version__','?'))"],
      { timeout: 30_000 });
    const verified = r3.code === 0;
    steps.push({ step: "verify_import", exit_code: r3.code, stdout: tail(r3.stdout), stderr: tail(r3.stderr) });

    // 4. Restart the bridge so it runs under the new venv python.
    await bridge?.stop().catch(() => {});
    bridge = null;

    const version = (r3.stdout || "").trim() || "unknown";
    const msg = `Bootstrapped codegraph venv at ${dir} (python ${pyExe}) — codegraph ${version}, import ${verified ? "OK" : "FAILED"}`;
    return ok(msg, { venv_path: dir, python: pyExe, codegraph_version: version, verified, steps });
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────
  pi.on("session_start", () => {
    // Restart the sidecar for a fresh session so cached graph state doesn't
    // leak across sessions.  Lazy-start keeps startup fast and avoids errors
    // when codegraph/Neo4j are unavailable — the new bridge starts on first use.
    const prev = bridge;
    bridge = new CodegraphBridge(resolvePython(), resolveBridgePath());
    void prev?.stop().catch(() => {});
    // Reset read-steering state so a new session gets fresh steering.
    steerUsedCodegraph = false;
    steerBlockedPaths.clear();
    steerBlockCount = 0;
  });

  pi.on("session_shutdown", () => {
    const b = bridge;
    bridge = null;
    void b?.stop().catch(() => {});
  });

  // ── Opt-in read steering (the "force graph tools first" wrinkle) ───────────
  // When --codegraph-steer-reads is on, block the *first* source-code `read` of
  // each distinct path until a codegraph_* tool has been called, returning a
  // steering reason the agent must respond to. Session-scoped state guards
  // against loops: a given path is blocked at most once, steering stops once the
  // agent uses any codegraph tool, and a hard cap bounds total blocks.
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
    // Observe codegraph tool usage (custom tools have free-form toolName).
    if (typeof event.toolName === "string" && event.toolName.startsWith("codegraph_")) {
      steerUsedCodegraph = true;
      return;
    }
    // Only steer source-code reads, and only when the flag is on. The flag
    // value may arrive as boolean true or the string "true"/"1" depending on CLI parsing.
    const steerRaw = pi.getFlag("codegraph-steer-reads");
    const steerOn = steerRaw === true || steerRaw === "true" || steerRaw === "1";
    if (!steerOn) return;
    if (event.toolName !== "read") return;
    // Once the agent has used a codegraph tool, stop steering for the session.
    if (steerUsedCodegraph) return;
    const path = (event.input as { path?: string } | undefined)?.path;
    if (typeof path !== "string" || !looksLikeSource(path)) return;
    // Never block the same path twice, and bound total blocks per session.
    if (steerBlockedPaths.has(path) || steerBlockCount >= STEER_CAP) return;
    steerBlockedPaths.add(path);
    steerBlockCount += 1;
    process.stderr.write(`[codegraph-steer] blocked first source read of ${path} this session — steering to codegraph_* tools (${steerBlockCount}/${STEER_CAP})\n`);
    return { block: true, reason: STEER_REASON };
  });

  // ── Tool 1: codegraph_query ─────────────────────────────────────────────
  pi.registerTool({
    name: "codegraph_query",
    label: "Codegraph Query",
    description:
      "Retrieve codebase knowledge-graph context from the codegraph Neo4j store and return it formatted for analysis. " +
      "Use the `scope` field to steer retrieval: 'tag' for an entire design view (design/as-built/dependency), " +
      "'namespace' for a module + everything it composes, 'compound' for a single class/interface/enum, " +
      "'neighborhood' for any node + its 1-hop relationships (the deep-inspection mode), 'source' for a whole " +
      "indexed project, 'kind' to list all nodes of a kind (e.g. all classes), or 'cached' to re-export the last " +
      "fetched graph in a different format without re-querying. " +
      "`format` selects markdown (default, human-readable public API + relationships), plantuml (class diagram), " +
      "component_plantuml (high-level component diagram with requirement annotations), " +
      "json (raw serialized graph), or html (interactive Cytoscape.js visualisation of the neighborhood, opened " +
      "in the browser). Results are cached server-side, so follow an expensive fetch with scope='cached' to switch " +
      "formats for free.",
    promptSnippet: "Fetch codegraph context (by tag/namespace/compound/neighborhood/source/kind) as markdown, plantuml, component_plantuml, json, or interactive HTML",
    promptGuidelines: [
      "Prefer codegraph_query to pull structured codebase context from the graph instead of grepping source.",
      "Start broad with scope='tag' to load an entire view, then scope='neighborhood' + a qualified_name to drill into one symbol.",
      "Use scope='cached' + a different format to re-export the last fetched graph without re-querying Neo4j.",
      "Use format='html' when the user wants to *see* the graph of a code object's neighborhood — it opens an interactive visualisation.",
      "scope='neighborhood' requires a fully-qualified name; use codegraph_explore action='search' first if you don't know it.",
      "For overview/troubleshooting queries (e.g. 'how many tests?'), use codegraph_stats instead of scope='kind' — stats is always compact and won't blow the context window.",
    ],
    parameters: Type.Object({
      scope: StringEnum(
        ["tag", "namespace", "compound", "neighborhood", "source", "kind", "cached"] as const,
        {
          description:
            "How to select the subgraph. 'tag' (needs tag), 'namespace'/'compound'/'neighborhood' (need qualified_name), " +
            "'source' (needs source), 'kind' (needs kind, optional tag), 'cached' (reuses the last fetched graph).",
        },
      ),
      format: StringEnum(
        ["markdown", "plantuml", "component_plantuml", "json", "html"] as const,
        {
          description: "Output format. 'markdown' (default): human-readable public API + relationships. 'plantuml': class diagram. 'component_plantuml': high-level component diagram with business-requirement annotations. 'json': raw serialized graph. 'html': interactive Cytoscape visualisation opened in the browser.",
        },
      ),
      qualified_name: Type.Optional(Type.String({
        description: "Fully-qualified name; required for scope=namespace/compound/neighborhood (e.g. 'calc::CalculatorEngine', 'codegraph.graph.LayerGraph').",
      })),
      tag: Type.Optional(Type.String({
        description: "Provenance tag: 'design', 'as-built', 'dependency'. Required for scope=tag; optional filter for scope=kind.",
      })),
      source: Type.Optional(Type.String({
        description: "Source project name (e.g. 'codegraph', 'llvm'). Required for scope=source.",
      })),
      kind: Type.Optional(Type.String({
        description: "Node kind for scope=kind: 'class','struct','interface','enum','union','module','concept','method','attribute','enumvalue','function','define','namespace'.",
      })),
      detail_level: Type.Optional(StringEnum(["high", "medium"] as const, {
        description: "component_plantuml only: 'high' shows component packages + requirement notes only; 'medium' also shows key class names inside packages (default 'high').",
      })),
      min_component_size: Type.Optional(Type.Number({
        description: "component_plantuml only: minimum entities a namespace must contain to be treated as a component (default 2).",
      })),
      public_only: Type.Optional(Type.Boolean({
        description: "markdown only: show only public API members (default true). Set false to include private/protected members.",
      })),
      size: Type.Optional(StringEnum(["large", "small"] as const, {
        description: "html only: layout size. 'large' (default) full-page, 'small' compact.",
      })),
      output: Type.Optional(Type.String({
        description: "html only: custom output HTML path. Defaults to a temp file.",
      })),
      open: Type.Optional(Type.Boolean({
        description: "html only: open the rendered HTML in the default browser (default true).",
      })),
    }),
    async execute(_id, params, signal) {
      try {
        const b = await ensureBridge();
        if (signal?.aborted) return err("codegraph_query aborted before dispatch");
        const res = await b.call("query", params as Record<string, unknown>);
        if (!res.ok) return err(`codegraph error: ${res.error}`, { error: res.error });

        const r = res.result;
        // HTML render result → open in browser, return the path.
        if (r && typeof r === "object" && "html_path" in (r as Record<string, unknown>)) {
          const info = r as { html_path: string; title: string; scope: string; size?: string };
          let opened = false;
          if (params.open !== false) {
            try { await openPath(pi, info.html_path); opened = true; }
            catch (e) { /* still return the path so the user can open it manually */ }
          }
          const msg = `Rendered codegraph HTML (${info.scope}${info.title ? `: ${info.title}` : ""}) → ${info.html_path}${opened ? " (opened in browser)" : " (open the file manually)"}`;
          return ok(msg, { opened, ...info });
        }
        // Text formats — the bridge returns a pre-formatted string.
        const text = typeof r === "string" ? r : JSON.stringify(r, null, 2);
        const scopeVal = params.scope as string;
        // Warn if a kind-based query returned a very large result
        // (common source of context-window blow-up). Suggest codegraph_stats.
        let resultText = text;
        if (scopeVal === "kind" && text.length > 30_000) {
          const kindVal = params.kind ?? "?";
          resultText =
            `⚠️  LARGE RESULT (${text.length.toLocaleString()} chars, kind=${kindVal}). ` +
            `Use codegraph_stats for a compact overview instead of fetching all ${kindVal} nodes. ` +
            `Result follows (truncated to first 10KB):\n\n` +
            text.slice(0, 10_240);
        }
        return ok(resultText, { format: params.format ?? "markdown", scope: scopeVal });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`codegraph_query failed: ${msg}`, { error: msg });
      }
    },
  });

  // ── Tool 2: codegraph_explore ────────────────────────────────────────────
  pi.registerTool({
    name: "codegraph_explore",
    label: "Codegraph Explore",
    description:
      "Lightweight lookups against the codegraph store that return slim JSON (not a full serialized graph). " +
      "Use this to *find* symbols and inspect relationships before fetching full context with codegraph_query. " +
      "`action` selects the lookup: 'search' (find compounds by qualified-name substring), 'compound' (a class + its " +
      "member list), 'member' (a single method/attribute), 'namespace' (list compounds under a namespace prefix), " +
      "'namespaces' (list all namespace nodes with entity counts — discover which namespaces are large enough to be components), " +
      "'sources' (list indexed source projects), 'tags' (list available provenance tags + node counts), " +
      "'inheritance' (parents + children of a compound), 'callers_callees' (what calls / is called by a member).",
    promptSnippet: "Look up codegraph symbols & relationships (search, compound, member, namespace, namespaces, inheritance, callers/callees, hlr_subtree, tags, sources)",
    promptGuidelines: [
      "Use codegraph_explore action='search' to find relevant classes by name when you don't yet know the qualified name.",
      "Use action='tags' or 'sources' first to discover what views/projects are indexed before fetching.",
      "Use action='namespaces' to list all namespaces with entity counts — find components without pulling the full graph.",
      "Use action='inheritance' / 'callers_callees' for relationship-specific lookups, then codegraph_query scope='neighborhood' for full context.",
      "Use action='hlr_subtree' with an HLR refid to retrieve the complete requirements tree (HLR → LLRs → tests → scaffold nodes) before decomposing or designing.",
      "These return compact JSON; follow up with codegraph_query to retrieve formatted, complete context for the symbols you found.",
    ],
    parameters: Type.Object({
      action: StringEnum(
        ["search", "compound", "member", "namespace", "namespaces", "sources", "tags", "inheritance", "callers_callees", "hlr_subtree"] as const,
        {
          description:
            "search (needs query): find compounds by name substring. compound/member/inheritance/callers_callees (need qualified_name). " +
            "namespace (needs namespace): list compounds under a prefix. sources / tags: list indexed projects / provenance tags. " +
            "hlr_subtree (needs refid): fetch the full requirements subtree (HLR→LLRs→tests→scaffolds).",
        },
      ),
      qualified_name: Type.Optional(Type.String({
        description: "Fully-qualified name; required for action=compound/member/inheritance/callers_callees.",
      })),
      query: Type.Optional(Type.String({
        description: "Substring to search for in compound qualified names (action=search).",
      })),
      namespace: Type.Optional(Type.String({
        description: "Namespace prefix to browse (action=namespace), e.g. 'std', 'codegraph.graph'.",
      })),
      source: Type.Optional(Type.String({
        description: "Filter search results by source project (action=search).",
      })),
      kind: Type.Optional(Type.String({
        description: "Filter search results by node kind, e.g. 'class','interface','enum' (action=search).",
      })),
      tag: Type.Optional(Type.String({
        description: "Optional tag filter (currently unused by explore actions but accepted for forward-compat).",
      })),
      limit: Type.Optional(Type.Number({
        description: "Maximum results for search/namespace (default 30 / 50).",
      })),
      refid: Type.Optional(Type.String({
        description: "HLR refid for action=hlr_subtree.",
      })),
    }),
    async execute(_id, params, signal) {
      try {
        const b = await ensureBridge();
        if (signal?.aborted) return err("codegraph_explore aborted before dispatch");
        const res = await b.call("explore", params as Record<string, unknown>);
        if (!res.ok) return err(`codegraph error: ${res.error}`, { error: res.error });
        const r = res.result;
        const text = typeof r === "string" ? r : JSON.stringify(r, null, 2);
        return ok(text, { action: params.action });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`codegraph_explore failed: ${msg}`, { error: msg });
      }
    },
  });

  // ── Tool 3: codegraph_tests ─────────────────────────────────────────────
  pi.registerTool({
    name: "codegraph_tests",
    label: "Codegraph Tests",
    description:
      "Test-focused exploration of the codegraph store, returning slim JSON. The store indexes tests (from `test_paths`) as `test` / `test_step` / `test_fixture` / `assertion` nodes linked to the code under test by `VERIFIES` (test → method/class) and `CALLEE` (test_step → called code). `action` selects the lookup: 'list' (all tests, filterable by source/module/tag, with the code each test verifies), 'modules' (tests grouped by test module), 'verifies' (given a test, the code it exercises), 'covered_by' (given a code node, the tests that verify it — including tests of a class's members, i.e. a coverage view; set detail=true to inline descriptions + step/fixture/assertion counts), 'detail' (one test: its verifies targets, steps with callees, fixtures, assertions), 'uncovered' (given a qualified_name prefix or source, returns classes/structs/interfaces/enums/unions with zero VERIFIES edges — the negative space of coverage). For a visual graph of a test's neighborhood, use codegraph_query scope='neighborhood' with the test's qualified_name.",
    promptSnippet: "Explore indexed tests: list tests, what a test verifies, what tests cover a given class/method, test detail (steps/fixtures/assertions)",
    promptGuidelines: [
      "Use action='list' (optionally with source/test_module) to see all indexed tests and how many code nodes each verifies.",
      "Use action='covered_by' with a class or method qualified_name to answer 'which tests cover this code?' — it includes tests of a class's members.",
      "Use action='verifies' with a test qualified_name to see exactly which code a test exercises; action='detail' for the full breakdown (steps, callees, fixtures, assertions).",
      "Pass detail=true with covered_by to inline each test's description and step/fixture/assertion counts — one call instead of N detail calls.",
      "Use action='uncovered' with a qualified_name prefix (e.g. 'codegraph.models.test') to find classes with zero test coverage — the negative space.",
      "These return compact JSON; for a rendered graph of a test's neighborhood use codegraph_query scope='neighborhood' with the test's qualified_name.",
    ],
    parameters: Type.Object({
      action: StringEnum(
        ["list", "detail", "verifies", "covered_by", "modules", "uncovered"] as const,
        {
          description:
            "list (optional source/test_module/tag filter): all tests + verifies counts. modules: tests grouped by test_module. " +
            "list (optional source/test_module/tag): all tests + verifies counts. modules: tests grouped by test_module. " +
            "verifies (needs qualified_name of a test): code it exercises. covered_by (needs qualified_name of a code node): tests that verify it (+ member tests). " +
            "detail (needs qualified_name of a test): verifies + steps(with callees) + fixtures + assertions. " +
            "uncovered (needs qualified_name prefix or source): classes/interfaces/enums/unions/structs with zero tests.",
        },
      ),
      qualified_name: Type.Optional(Type.String({
        description: "Test qualified_name (for action=verifies/detail) or code-node qualified_name (for action=covered_by). For action=uncovered, a namespace prefix (e.g. 'codegraph.models.test') to scope the negative-coverage search.",
      })),
      source: Type.Optional(Type.String({
        description: "Filter by source project (action=list/modules).",
      })),
      test_module: Type.Optional(Type.String({
        description: "Filter by test module, e.g. 'test_calculator' (action=list/modules).",
      })),
      tag: Type.Optional(Type.String({
        description: "Filter by provenance tag (action=list/modules).",
      })),
      limit: Type.Optional(Type.Number({
        description: "Maximum tests to return for action=list (default 100).",
      })),
      detail: Type.Optional(Type.Boolean({
        description: "For action=covered_by: when true, inlines each test's description and step/fixture/assertion counts into the result entries.",
      })),
    }),
    async execute(_id, params, signal) {
      try {
        const b = await ensureBridge();
        if (signal?.aborted) return err("codegraph_tests aborted before dispatch");
        const res = await b.call("tests", params as Record<string, unknown>);
        if (!res.ok) return err(`codegraph error: ${res.error}`, { error: res.error });
        const r = res.result;
        const text = typeof r === "string" ? r : JSON.stringify(r, null, 2);
        return ok(text, { action: params.action });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`codegraph_tests failed: ${msg}`, { error: msg });
      }
    },
  });

  // ── Tool 3.5: codegraph_stats ───────────────────────────────────────────
  pi.registerTool({
    name: "codegraph_stats",
    label: "Codegraph Statistics",
    description:
      "Returns compact, high-level statistics about the codegraph store: total node/relationship counts, " +
      "node counts by kind, source, and tag, description coverage per kind, relationship type breakdown, " +
      "and a test summary. Use this instead of ``codegraph_query scope='kind'`` or ``codegraph_explore action='tags'`` " +
      "when you need a quick overview or are troubleshooting — it's always a few hundred bytes regardless of " +
      "graph size, and will never blow the context window.",
    promptSnippet: "Get high-level graph statistics (counts by kind/source/tag, description coverage, test summary)",
    promptGuidelines: [
      "Use codegraph_stats to get an overview before diving into specific queries. It's always compact.",
      "When troubleshooting (e.g. 'why are test descriptions empty?'), run codegraph_stats first to get the big picture.",
      "codegraph_stats replaces ad-hoc 'show me everything of kind X' queries that can blow context windows.",
    ],
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      try {
        const b = await ensureBridge();
        if (signal?.aborted) return err("codegraph_stats aborted before dispatch");
        const res = await b.call("stats", {});
        if (!res.ok) return err(`stats error: ${res.error}`, { error: res.error });
        const r = res.result;
        const text = typeof r === "string" ? r : JSON.stringify(r, null, 2);
        return ok(text, {});
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`codegraph_stats failed: ${msg}`, { error: msg });
      }
    },
  });

  // ── Tool 4: codegraph_setup ─────────────────────────────────────────────
  pi.registerTool({
    name: "codegraph_setup",
    label: "Codegraph Setup",
    description:
      "Bootstrap and operate the codegraph knowledge graph for a project: provision the Python environment, " +
      "generate the `.doxygen-index.toml` config from the repo's contents, start/stop the project-local Neo4j " +
      "Docker container, and index source code into the graph. Use the `action` field to steer: " +
      "'bootstrap_env' (create/refresh a venv with codegraph + doxygen-index installed — run this first on a new machine), " +
      "'init_config' (auto-detect language/inputs/tests and write `.doxygen-index.toml`), 'index' (parse the project and " +
      "ingest into Neo4j or JSON; clear defaults to false so it won't wipe existing data — pass clear=true to replace a source), " +
      "'db_start'/'db_stop'/'db_restart'/'db_status' (manage the Neo4j Docker container), " +
      "'db_backup' (create a dump or tar backup — container is briefly stopped), " +
      "'db_restore' (restore from a backup file — WARNING: destroys current data, safety backup created first), " +
      "'db_backups' (list available backup files with size and timestamp), " +
      "'bootstrap' (one-shot: init_config → db_start → index, with clear=true), or 'status' (bridge + Neo4j + Docker + tags health).",
    promptSnippet: "Provision env, create .doxygen-index.toml, manage Neo4j Docker, and index a project into the codegraph",
    promptGuidelines: [
      "DESTRUCTIVE: action='index' and action='bootstrap' re-index a project and can REPLACE existing graph data for that source. Only run them when the user EXPLICITLY asks to (re)index or bootstrap a project — never as a shortcut to 'explore' or 'set up the graph' when asked to read or understand code.",
      "On a fresh machine, call codegraph_setup action='bootstrap_env' once before anything else — it creates a venv with codegraph + doxygen-index.",
      "Use action='db_backup' to create a backup before risky operations like re-indexing with clear=true. Pass mode='tar' for speed or mode='dump' (default) for portability.",
      "Use action='db_backups' to list available backup files before restoring.",
      "DESTRUCTIVE: action='db_restore' replaces the entire database from a backup file. A safety backup is created automatically first. Only run when the user explicitly asks to restore.",
      "To graph a new project end-to-end: codegraph_setup action='bootstrap' with project_dir — it writes the config, starts Neo4j, and indexes.",
      "Use action='init_config' to generate/refresh `.doxygen-index.toml` from a repo (auto-detects C++ vs Python, input/test paths, project name).",
      "Use action='db_start' before action='index' with format='neo4j'; action='db_status' checks the container.",
      "After indexing, switch to codegraph_query / codegraph_explore / codegraph_tests to retrieve the graph context you just created.",
    ],
    parameters: Type.Object({
      action: StringEnum(
        ["bootstrap_env", "init_config", "index", "db_start", "db_stop", "db_restart", "db_status", "db_backup", "db_restore", "db_backups", "bootstrap", "status"] as const,
        { description: "Which setup operation to perform (see tool description)." },
      ),
      project_dir: Type.Optional(Type.String({
        description: "Project directory. Required for init_config/index/db_*/bootstrap; optional for status. Defaults to cwd.",
      })),
      language: Type.Optional(StringEnum(["cpp", "python"] as const, {
        description: "init_config: override auto-detected language.",
      })),
      name: Type.Optional(Type.String({ description: "init_config: override auto-detected project name." })),
      input_paths: Type.Optional(Type.Array(Type.String(), {
        description: "init_config: override auto-detected source input paths (e.g. ['src'] or ['include','src']).",
      })),
      test_paths: Type.Optional(Type.Array(Type.String(), {
        description: "init_config: override auto-detected test directories (Python only).",
      })),
      format: Type.Optional(StringEnum(["neo4j", "json"] as const, {
        description: "index: output format. 'neo4j' (default) ingests into the graph; 'json' writes a JSON file (and HTML if [codegraph-html] is configured).",
      })),
      html: Type.Optional(Type.Boolean({
        description: "init_config: include a [codegraph-html] section so doxygen-index also emits an interactive HTML graph (default true).",
      })),
      force: Type.Optional(Type.Boolean({
        description: "init_config: overwrite an existing .doxygen-index.toml (default false — returns the existing one instead).",
      })),
      clear: Type.Optional(Type.Boolean({
        description: "index: clear existing data for this source before ingesting into Neo4j (default false — won't wipe existing data; pass true to replace a source).",
      })),
      source: Type.Optional(Type.String({ description: "index: source provenance label (default: project name from config)." })),
      output_dir: Type.Optional(Type.String({ description: "index: override output directory." })),
      timeout: Type.Optional(Type.Number({
        description: "index/db_*: per-command timeout in seconds (default 600 for index, 120 for db).",
      })),
      mode: Type.Optional(StringEnum(["dump", "tar"] as const, {
        description: "db_backup only: backup mode. 'dump' (default): logical neo4j-admin dump producing a portable .dump file. 'tar': fast filesystem-level tar.gz of the data directory.",
      })),
      keep: Type.Optional(Type.Number({
        description: "db_backup only: retention — keep only the last N backup files of the same mode, deleting older ones.",
      })),
      backup_file: Type.Optional(Type.String({
        description: "db_restore only: path to the backup file to restore. If omitted, lists available backups instead of restoring.",
      })),
      codegraph_source: Type.Optional(Type.String({
        description: "bootstrap_env: pip spec or local path for codegraph (default: flag --codegraph-source or 'codegraph').",
      })),
      doxygen_index_source: Type.Optional(Type.String({
        description: "bootstrap_env: pip spec or local path for doxygen-index (default: flag --doxygen-index-source or 'doxygen-index').",
      })),
    }),
    async execute(_id, params, signal) {
      try {
        // bootstrap_env runs TS-side (the bridge can't start before the venv exists).
        if (params.action === "bootstrap_env") {
          if (signal?.aborted) return err("codegraph_setup aborted before dispatch");
          return await bootstrapEnv(params as Record<string, unknown>);
        }
        const b = await ensureBridge();
        if (signal?.aborted) return err("codegraph_setup aborted before dispatch");
        const tmo = params.action === "index" || params.action === "bootstrap"
          ? SETUP_TIMEOUT_MS : 180_000;
        const res = await b.call("setup", params as Record<string, unknown>, tmo);
        if (!res.ok) return err(`codegraph setup error: ${res.error}`, { error: res.error });
        const r = res.result;
        const text = typeof r === "string" ? r : JSON.stringify(r, null, 2);
        return ok(text, { action: params.action, raw: r });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`codegraph_setup failed: ${msg}`, { error: msg });
      }
    },
  });

  // ── Tool 5: codegraph_discover ───────────────────────────────────────
  pi.registerTool({
    name: "codegraph_discover",
    label: "Codegraph Discover",
    description:
      "Discover existing requirements (HLRs/LLRs) and related code before designing a new feature. " +
      "Actions: search_requirements (keyword search), get_hlr_dependencies (DEPENDS_ON traversal), " +
      "list_requirements (browse by component/tag), get_requirement_traces (requirement → code links), " +
      "build_design_context (assemble full context document for design agent). " +
      "Use this BEFORE designing to understand what already exists.",
    promptSnippet: "Discover existing requirements & code before designing (search_requirements, get_hlr_dependencies, list_requirements, get_requirement_traces, build_design_context)",
    promptGuidelines: [
      "Call codegraph_discover action='build_design_context' with a feature description to get a structured context document for design.",
      "Use action='search_requirements' to find related HLRs/LLRs by keyword before designing a new feature.",
      "Use action='get_hlr_dependencies' to find which HLRs a requirement depends on (DEPENDS_ON edges).",
      "codegraph_discover complements codegraph_query and codegraph_explore: discover finds requirements, query/explore find code.",
    ],
    parameters: Type.Object({
      action: StringEnum(
        ["search_requirements", "get_hlr_dependencies", "list_requirements", "get_requirement_traces", "build_design_context", "ingest_design", "generate_hlr_docs", "generate_feedback_docs", "evaluate_coverage", "verify_callee_granularity"] as const,
        {
          description:
            "search_requirements (needs query): keyword search across HLR/LLR descriptions. " +
            "get_hlr_dependencies (needs refid): traverse DEPENDS_ON edges from an HLR. " +
            "list_requirements (optional component_name/tag): browse all HLRs. " +
            "get_requirement_traces (needs refid): requirement → design node COMPOSES edges. " +
            "build_design_context (needs feature_description): assemble full context document. " +
            "ingest_design (needs file_path): ingest a design/tests markdown file into Neo4j. " +
            "generate_hlr_docs: generate per-HLR documents from Neo4j. " +
            "generate_feedback_docs: generate feedback review documents. " +
            "evaluate_coverage: evaluate test coverage and design smells. " +
            "verify_callee_granularity: verify CALLEE edges target correct level.",
        },
      ),
      query: Type.Optional(Type.String({
        description: "Search text for action=search_requirements.",
      })),
      scope: Type.Optional(Type.String({
        description: "Search scope for action=search_requirements: 'hlr', 'llr', or 'both' (default both).",
      })),
      limit: Type.Optional(Type.Number({
        description: "Max results for action=search_requirements (default 20).",
      })),
      refid: Type.Optional(Type.String({
        description: "HLR or LLR refid for action=get_hlr_dependencies or action=get_requirement_traces.",
      })),
      direction: Type.Optional(Type.String({
        description: "Traversal direction for action=get_hlr_dependencies: 'outgoing', 'incoming', or 'both' (default outgoing).",
      })),
      component_name: Type.Optional(Type.String({
        description: "Component name filter for action=list_requirements or action=build_design_context.",
      })),
      tag: Type.Optional(Type.String({
        description: "Tag filter for action=list_requirements (e.g. 'design', 'as-built').",
      })),
      feature_description: Type.Optional(Type.String({
        description: "Feature description for action=build_design_context.",
      })),
      file_path: Type.Optional(Type.String({
        description: "Path to markdown file for action=ingest_design.",
      })),
      output_path: Type.Optional(Type.String({
        description: "Output path for action=evaluate_coverage (JSON report).",
      })),
    }),
    async execute(_id, params, signal) {
      try {
        const b = await ensureBridge();
        if (signal?.aborted) return err("codegraph_discover aborted before dispatch");
        const res = await b.call("discover", params as Record<string, unknown>);
        if (!res.ok) return err(`codegraph_discover error: ${res.error}`, { error: res.error });
        const r = res.result;
        const text = typeof r === "string" ? r : JSON.stringify(r, null, 2);
        return ok(text, { action: params.action });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`codegraph_discover failed: ${msg}`, { error: msg });
      }
    },
  });

  // ── Tool 6: codegraph_decompose ─────────────────────────────────────────
  pi.registerTool({
    name: "codegraph_decompose",
    label: "Codegraph Decompose",
    description:
      "Run the decompose_hlr agent to break down a high-level requirement (HLR) into low-level requirements (LLRs) " +
      "with verification stubs. Accepts either a Neo4j HLR refid (loads from the graph, decomposes, persists) " +
      "or a raw description string (decomposes only, no persistence). " +
      "When an HLR refid is provided, the agent automatically loads the existing requirements tree " +
      "(existing LLRs, tests, scaffold nodes) and completes gaps rather than starting from scratch — " +
      "it fills in missing tests, assertions, and steps for partially complete requirements. " +
      "Returns the flat list of codegraph node dicts (LLRs, TestNodes, AssertionNodes, TestStepNodes) " +
      "or a summary of persisted results. This is a heavy, long-running tool (makes LLM API calls).",
    promptSnippet: "Decompose an HLR into LLRs with verification stubs — fills in gaps for partially complete requirements",
    promptGuidelines: [
      "Use codegraph_decompose to decompose a high-level requirement into low-level requirements with test stubs.",
      "Pass 'hlr_refid' to decompose an existing HLR from Neo4j; pass 'description' to decompose a raw description.",
      "After decomposition, use codegraph_design to produce the OO class design.",
      "This tool runs an LLM agent internally — it may take 30-120 seconds.",
    ],
    parameters: Type.Object({
      hlr_refid: Type.Optional(Type.String({
        description: "The HLR refid (hex UUID) to load from Neo4j, decompose, and persist.",
      })),
      description: Type.Optional(Type.String({
        description: "Raw HLR description text for one-shot decomposition (no persistence).",
      })),
      component: Type.Optional(Type.String({
        description: "Name of the architectural component this HLR belongs to (for description mode).",
      })),
      model: Type.Optional(Type.String({
        description: "LLM model override (passed to llm_caller).",
      })),
      log_dir: Type.Optional(Type.String({
        description: "Directory for per-step prompt logs.",
      })),
    }),
    async execute(_id, params, signal) {
      try {
        const b = await ensureBridge();
        if (signal?.aborted) return err("codegraph_decompose aborted before dispatch");
        // Long timeout — LLM calls can be slow
        const res = await b.call("decompose_run", params as Record<string, unknown>, 300_000);
        if (!res.ok) return err(`codegraph_decompose error: ${res.error}`, { error: res.error });
        const r = res.result;
        const text = typeof r === "string" ? r : JSON.stringify(r, null, 2);
        return ok(text, {});
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`codegraph_decompose failed: ${msg}`, { error: msg });
      }
    },
  });

  // ── Tool 7: codegraph_design ────────────────────────────────────────────
  pi.registerTool({
    name: "codegraph_design",
    label: "Codegraph Design",
    description:
      "Run the design_oo agent to produce an object-oriented class design and resolve notional verification " +
      "stubs to qualified design names. Requires the HLR to already have LLRs (decompose it first). " +
      "Loads HLR + LLRs from Neo4j, runs the design + verification tool loop (up to 75 turns), " +
      "persists the design by updating scaffold nodes in place to preserve verification edges. " +
      "Returns a summary of nodes created/updated, verifications resolved, and scaffold cleanup. " +
      "This is a heavy, long-running tool (makes LLM API calls).",
    promptSnippet: "Design OO class structure and resolve verification stubs for an HLR (design_run via codegraph bridge)",
    promptGuidelines: [
      "Use codegraph_design AFTER codegraph_decompose — the HLR must have LLRs with verification stubs.",
      "Pass 'hlr_refid' to design an existing HLR from Neo4j.",
      "After design, run codegraph_discover action='generate_hlr_docs' to export readable documents.",
      "Then use codegraph_discover action='generate_feedback_docs' to create review templates.",
      "This tool runs an LLM agent internally — it may take 60-300 seconds.",
    ],
    parameters: Type.Object({
      hlr_refid: Type.Optional(Type.String({
        description: "The HLR refid (hex UUID) to load from Neo4j, design, and persist.",
      })),
      log_dir: Type.Optional(Type.String({
        description: "Directory for per-step prompt logs.",
      })),
    }),
    async execute(_id, params, signal) {
      try {
        const b = await ensureBridge();
        if (signal?.aborted) return err("codegraph_design aborted before dispatch");
        // Long timeout — design tool loop can be very slow
        const res = await b.call("design_run", params as Record<string, unknown>, 600_000);
        if (!res.ok) return err(`codegraph_design error: ${res.error}`, { error: res.error });
        const r = res.result;
        const text = typeof r === "string" ? r : JSON.stringify(r, null, 2);
        return ok(text, {});
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`codegraph_design failed: ${msg}`, { error: msg });
      }
    },
  });

  // ── /codegraph command ──────────────────────────────────────────────────
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
        // /codegraph bootstrap [codegraph-src] [doxygen-index-src]
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
        // /codegraph python [path|--clear]
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
      // status
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