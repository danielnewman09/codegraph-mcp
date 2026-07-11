/**
 * shared — infrastructure for the codegraph Pi extension.
 *
 * Exports the CodegraphBridge JSON-RPC client, result helpers, constants,
 * and the cross-platform file-opener.  All tool modules import from here.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_BRIDGE = join(__dirname, "bridge", "codegraph_bridge.py");
export const DEFAULT_VENV = join(homedir(), ".pi", "agent", "codegraph", "venv");
export const CONFIG_DIR = join(homedir(), ".pi", "agent", "codegraph");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");
export const CALL_TIMEOUT_MS = 120_000;
export const SETUP_TIMEOUT_MS = 600_000;
export const WIN = platform() === "win32";

// ── BridgeResponse ────────────────────────────────────────────────────────

export interface BridgeResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

// ── CodegraphBridge: stdio JSON-RPC client over a long-lived Python child ──

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
    private readonly extraEnv: Record<string, string> = {},
  ) {}

  isRunning(): boolean {
    return !!this.proc && !this.dead;
  }

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
      env: { ...process.env, ...this.extraEnv },
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
      try { msg = JSON.parse(line); } catch { continue; }
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
    try { p.stdin?.end(); } catch { /* ignore */ }
    const killer = setTimeout(() => {
      try { p.kill("SIGKILL"); } catch { /* ignore */ }
    }, 2000);
    p.once("exit", () => clearTimeout(killer));
    try { p.kill("SIGTERM"); } catch { /* ignore */ }
  }
}

// ── Cross-platform "open path" helper ──────────────────────────────────────

export async function openPath(pi: ExtensionAPI, target: string): Promise<void> {
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

export function ok(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

export function err(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details, isError: true };
}

export function tail(s: string, limit = 6000): string {
  if (!s) return "";
  return s.length <= limit ? s : "…(truncated)…\n" + s.slice(-limit);
}

// ── Progress reporter for long-running tools ───────────────────────────────
//
// Provides visual feedback during blocking bridge calls (decompose, design)
// by emitting periodic onUpdate callbacks with elapsed time and a status label.
// The bridge protocol is request→response (no streaming), so this is purely
// client-side: it shows the user something is happening while we wait.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type UpdateCb = (partial: { content: Array<{ type: "text"; text: string }>; details: any }) => void;

export interface ProgressHandle {
  stop: () => void;
  /** Update the status label (e.g. "Decomposing HLR…"). */
  setLabel: (label: string) => void;
}

export function startProgress(
  onUpdate: UpdateCb | undefined,
  label: string,
  intervalMs = 3000,
): ProgressHandle {
  if (!onUpdate) return { stop: () => {}, setLabel: () => {} };
  const start = Date.now();
  let currentLabel = label;

  const emit = () => {
    const elapsed = Math.floor((Date.now() - start) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    const timeStr = mins > 0 ? `${mins}m${secs.toString().padStart(2, "0")}s` : `${secs}s`;
    onUpdate({
      content: [{ type: "text", text: `⏳ ${currentLabel} (${timeStr})` }],
      details: { progress: true, elapsed_seconds: elapsed, label: currentLabel },
    });
  };

  emit(); // immediate first update
  const timer = setInterval(emit, intervalMs);

  return {
    stop: () => clearInterval(timer),
    setLabel: (l: string) => { currentLabel = l; },
  };
}
