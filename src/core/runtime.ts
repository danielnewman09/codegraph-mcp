/**
 * CodegraphRuntime — host-neutral runtime that owns the bridge lifecycle,
 * configuration, subprocess execution, and bootstrap environment.
 *
 * It must not register tools with any host and must not import Pi or MCP
 * packages.  The constructor takes an already-resolved `RuntimeConfig` so
 * tests can inject temporary directories.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  CodegraphBridge,
  CALL_TIMEOUT_MS,
  SETUP_TIMEOUT_MS,
  type BridgeResponse,
} from "./bridge.js";
import {
  loadEnvFile,
  readConfig,
  writeConfig,
  venvBinPath,
  venvPythonPath,
  venvPresent,
  type RuntimeConfig,
} from "./config.js";
import { runProcess, type ProcessResult } from "./subprocess.js";
import { tail, bridgeResultFromResponse } from "./results.js";
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

export class CodegraphRuntime {
  readonly config: RuntimeConfig;
  private bridge: CodegraphBridge | null = null;

  constructor(config: RuntimeConfig) {
    this.config = config;
  }

  // ── Bridge lifecycle ───────────────────────────────────────────

  /** Start the bridge once and keep it for the process lifetime. */
  async ensureBridge(): Promise<CodegraphBridge> {
    if (this.bridge && this.bridge.isRunning()) return this.bridge;
    if (!this.bridge) {
      const projectEnv = loadEnvFile(join(this.config.cwd, ".env"));
      this.bridge = new CodegraphBridge(
        this.config.python,
        this.config.bridgePath,
        projectEnv,
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
   * for `timeoutClass` when given.
   */
  async call(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<BridgeCallResult> {
    const b = await this.ensureBridge();
    const res = await b.call(method, params, timeoutMs ?? CALL_TIMEOUT_MS);
    return bridgeResultFromResponse(res, { method });
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
    return b.call("ping", {}, 15_000);
  }
}
