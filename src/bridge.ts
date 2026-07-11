/**
 * CodegraphBridge — stdio JSON-RPC client over a long-lived Python sidecar.
 *
 * Spawns ``<python> bridge/codegraph_bridge.py``, speaks newline-delimited
 * JSON on its stdin/stdout, and routes correlation-ids back to awaiting
 * callers.  Stderr from the child is forwarded to the host so diagnostics
 * are visible.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { platform } from "node:os";

const WIN = platform() === "win32";
export const CALL_TIMEOUT_MS = 120_000; // Neo4j fetches can be slow on large graphs
export const SETUP_TIMEOUT_MS = 600_000; // indexing / pip install can take minutes

// ── Response type ─────────────────────────────────────────────────────────

export interface BridgeResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

// ── Bridge class ─────────────────────────────────────────────────────────

export class CodegraphBridge {
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
        continue;
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
