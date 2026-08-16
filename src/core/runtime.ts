/**
 * CodegraphRuntime — host-neutral runtime that owns the bridge lifecycle,
 * configuration, subprocess execution, and bootstrap environment.
 *
 * It must not register tools with any host and must not import Pi or MCP
 * packages.  The constructor takes an already-resolved `RuntimeConfig` so
 * tests can inject temporary directories.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  CodegraphBridge,
  CALL_TIMEOUT_MS,
  SETUP_TIMEOUT_MS,
  type BridgeResponse,
} from "./bridge.js";
import {
  loadEnvFile,
  pluginRoot,
  readConfig,
  writeConfig,
  venvBinPath,
  venvPythonPath,
  venvPresent,
  type RuntimeConfig,
} from "./config.js";
import { runProcess, type ProcessResult } from "./subprocess.js";
import { tail, bridgeResultFromResponse } from "./results.js";
import {
  assertDatabaseOutsidePlugin,
  type ProjectContext,
} from "./project.js";
import type {
  BridgeCallResult,
  TimeoutClass,
  ToolResult,
} from "./types.js";

const DEFAULT_TIMEOUTS: Record<TimeoutClass, number> = {
  normal: CALL_TIMEOUT_MS,
  setup: SETUP_TIMEOUT_MS,
  agent: SETUP_TIMEOUT_MS,
};

/**
 * Resolve a child-executable path against the TS process cwd so it stays
 * valid when the bridge runs with a different (project) cwd.  Bare command
 * names (`node`, `python3`) pass through untouched.
 */
function normalizeChildExecutable(p: string): string {
  if (isAbsolute(p)) return p;
  if (p.includes("/") || p.includes("\\")) return resolve(p);
  return p;
}

export class CodegraphRuntime {
  readonly config: RuntimeConfig;
  private bridge: CodegraphBridge | null = null;
  private _project: ProjectContext | null = null;
  /** In-flight bridge calls started through this runtime. */
  private inFlight = new Set<Promise<unknown>>();

  constructor(config: RuntimeConfig, project?: ProjectContext) {
    this.config = config;
    this._project = project ?? null;
  }

  /** The resolved project context (manifest / SQLITE_PATH / fallback). */
  get project(): ProjectContext | null {
    return this._project;
  }

  /**
   * Swap the active project.  Waits for in-flight bridge calls to settle
   * first, then stops the bridge so the new project's database/environment
   * is picked up on the next call — we never switch a bridge with active
   * work (which would kill an in-progress index or migration).
   */
  async updateProject(project: ProjectContext | null): Promise<void> {
    await this.waitForIdle();
    await this.stopBridge();
    this._project = project;
  }

  /**
   * Wait until no bridge calls are in flight.  Calls carry their own
   * timeouts, so this settles naturally; a hard cap only guards against a
   * pathological stuck caller.
   */
  private async waitForIdle(capMs = 600_000): Promise<void> {
    const started = Date.now();
    while (this.inFlight.size > 0) {
      if (Date.now() - started > capMs) {
        process.stderr.write(
          `[codegraph] updateProject: giving up after ${capMs}ms waiting for active bridge calls — replacing the bridge anyway\n`,
        );
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  // ── Bridge lifecycle ───────────────────────────────────────────

  /** Start the bridge once and keep it for the process lifetime. */
  async ensureBridge(): Promise<CodegraphBridge> {
    if (this.bridge && this.bridge.isRunning()) return this.bridge;
    if (!this.bridge) {
      const projectEnv = loadEnvFile(join(this.config.cwd, ".env"));
      const env: Record<string, string> = { ...projectEnv };
      let cwd: string | undefined = this.config.cwd;

      if (this._project) {
        const p = this._project;
        // Startup invariant: the plugin bundle is code, not writable state.
        assertDatabaseOutsidePlugin(p.databasePath, pluginRoot());
        // Create the database parent directory before backend startup so the
        // bridge can open the file on first write.
        mkdirSync(dirname(p.databasePath), { recursive: true });
        // The resolved absolute database path is authoritative; project .env
        // files may contribute unrelated settings but must not replace it.
        env.SQLITE_PATH = p.databasePath;
        env.CODEGRAPH_PROJECT_ID = p.id;
        if (p.manifestPath) env.CODEGRAPH_PROJECT_FILE = p.manifestPath;
        cwd = p.projectDir;
      }

      // The bridge child runs with the project directory as cwd, so its
      // interpreter/bridge paths must be absolute (or bare command names).
      this.bridge = new CodegraphBridge(
        normalizeChildExecutable(this.config.python),
        normalizeChildExecutable(this.config.bridgePath),
        env,
        { cwd },
      );
    }
    await this.bridge.start();
    return this.bridge;
  }

  /** Stop the bridge (idempotent). */
  async stopBridge(): Promise<void> {
    const b = this.bridge;
    this.bridge = null;
    await b?.stop().catch(() => {});
  }

  /** Restart the bridge under the current configuration. */
  async restartBridge(): Promise<void> {
    await this.stopBridge();
    await this.ensureBridge();
  }

  // ── Bridge calls ───────────────────────────────────────────────

  /**
   * Call a bridge method, converting the raw response into a
   * host-neutral `BridgeCallResult`.  `timeoutMs` overrides the default
   * for `timeoutClass` when given.  In-flight calls are tracked so
   * `updateProject` can wait for them before replacing the bridge.
   */
  async call(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<BridgeCallResult> {
    const b = await this.ensureBridge();
    const p = b.call(method, params, timeoutMs ?? CALL_TIMEOUT_MS)
      .then((res) => bridgeResultFromResponse(res, { method }));
    return this.track(p);
  }

  /**
   * Call a bridge method by timeout class (used by the tool catalog).
   */
  async callClass(
    method: string,
    params: Record<string, unknown>,
    timeoutClass: TimeoutClass = "normal",
  ): Promise<BridgeCallResult> {
    return this.call(method, params, DEFAULT_TIMEOUTS[timeoutClass]);
  }

  // ── Persisted python (for the Pi `/codegraph python` command) ──

  persistPython(python: string): void {
    writeConfig(this.config.configFile, { python });
  }

  clearPersistedPython(): void {
    writeConfig(this.config.configFile, { python: undefined });
  }

  persistedPython(): string | undefined {
    return readConfig(this.config.configFile).python;
  }

  // ── Venv helpers (for the Pi `/codegraph venv` command) ────────

  venvInfo(): { dir: string; python: string; pip: string; present: boolean } {
    return {
      dir: this.config.venvDir,
      python: venvPythonPath(this.config.venvDir),
      pip: venvBinPath(this.config.venvDir, "pip"),
      present: venvPresent(this.config.venvDir),
    };
  }

  // ── bootstrap_env ──────────────────────────────────────────────

  /** pip spec: local path → editable install, otherwise the spec. */
  private pipSpec(spec: string): string[] {
    return existsSync(spec) ? ["-e", spec] : [spec];
  }

  /**
   * Provision (or refresh) the bootstrapped venv with codegraph +
   * doxygen-index, then restart the bridge under it.
   */
  async bootstrapEnv(params: Record<string, unknown>): Promise<ToolResult> {
    const dir = this.config.venvDir;
    const pyExe = venvPythonPath(dir);
    const pipExe = venvBinPath(dir, "pip");
    const base = this.config.pythonBase;
    const steps: Array<Record<string, unknown>> = [];

    const codegraphSpec = (params.codegraph_source as string | undefined)
      ?? this.config.codegraphSource;
    const doxySpec = (params.doxygen_index_source as string | undefined)
      ?? this.config.doxygenIndexSource;
    const cgArgs = this.pipSpec(codegraphSpec);
    const dxArgs = this.pipSpec(doxySpec);

    if (!venvPresent(dir)) {
      const r: ProcessResult = await runProcess({
        command: base,
        args: ["-m", "venv", "--upgrade-deps", dir],
        timeoutMs: 180_000,
      });
      steps.push({ step: "venv_create", exit_code: r.code, killed: r.killed, stderr: tail(r.stderr) });
      if (r.code !== 0) {
        return {
          ok: false as const,
          text: `Failed to create venv at ${dir} (using ${base}): ${r.stderr || "exit " + r.code}`,
          details: { venv_path: dir, steps },
        };
      }
    } else {
      steps.push({ step: "venv_create", skipped: true, venv_path: dir });
    }

    const installArgs = ["install", "-U", ...cgArgs, ...dxArgs];
    const r2: ProcessResult = await runProcess({
      command: pipExe,
      args: installArgs,
      timeoutMs: SETUP_TIMEOUT_MS,
    });
    steps.push({ step: "pip_install", exit_code: r2.code, killed: r2.killed,
      stdout: tail(r2.stdout), stderr: tail(r2.stderr) });
    if (r2.code !== 0) {
      return {
        ok: false as const,
        text: `pip install failed (exit ${r2.code}): ${tail(r2.stderr) || tail(r2.stdout)}`,
        details: { venv_path: dir, steps, install_args: installArgs },
      };
    }

    const r3: ProcessResult = await runProcess({
      command: pyExe,
      args: ["-c", "import codegraph, doxygen_index; print(getattr(codegraph,'__version__','?'))"],
      timeoutMs: 30_000,
    });
    const verified = r3.code === 0;
    steps.push({ step: "verify_import", exit_code: r3.code, stdout: tail(r3.stdout), stderr: tail(r3.stderr) });

    await this.stopBridge();

    const version = (r3.stdout || "").trim() || "unknown";
    const msg = `Bootstrapped codegraph venv at ${dir} (python ${pyExe}) — codegraph ${version}, import ${verified ? "OK" : "FAILED"}`;
    return {
      ok: true as const,
      text: msg,
      details: { venv_path: dir, python: pyExe, codegraph_version: version, verified, steps },
    };
  }

  /** Raw bridge call for the Pi command handler (keeps BridgeResponse). */
  async ping(): Promise<BridgeResponse> {
    const b = await this.ensureBridge();
    const p = b.call("ping", {}, 15_000);
    return this.track(p);
  }

  /** Track an in-flight bridge promise until it settles. */
  private track<T>(p: Promise<T>): Promise<T> {
    this.inFlight.add(p);
    const done = () => { this.inFlight.delete(p); };
    p.then(done, done);
    return p;
  }
}
