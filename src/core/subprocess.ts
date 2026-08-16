/**
 * Generic subprocess runner — host-neutral replacement for ad-hoc
 * `spawn`/`pi.exec` usage.  Argument arrays only (never shell strings),
 * captured stdout/stderr, optional timeout and cancellation, and a
 * stable result shape.
 */

import { spawn } from "node:child_process";

export interface ProcessResult {
  code: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  killed?: boolean;
  timedOut?: boolean;
}

export interface RunProcessOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called with decoded stdout chunks as they arrive. */
  onStdout?: (chunk: string) => void;
  /** Called with decoded stderr chunks as they arrive. */
  onStderr?: (chunk: string) => void;
}

export function runProcess(opts: RunProcessOptions): Promise<ProcessResult> {
  const { command, args } = opts;
  return new Promise<ProcessResult>((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let killedBySignal = false;

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      opts.onStdout?.(chunk);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      opts.onStderr?.(chunk);
    });

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          try { child.kill("SIGTERM"); } catch { /* ignore */ }
          try { child.kill("SIGKILL"); } catch { /* ignore */ }
        }, opts.timeoutMs)
      : undefined;

    const onAbort = () => {
      killedBySignal = true;
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    const finish = (result: ProcessResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    child.on("error", (err) => {
      // spawn failure (command not found, permission, ...)
      finish({
        code: 1,
        stdout,
        stderr: stderr || `failed to spawn ${command}: ${err.message}`,
        killed: killedBySignal,
      });
    });
    child.on("exit", (code, signal) => {
      finish({
        code,
        signal: signal ?? undefined,
        stdout,
        stderr,
        killed: killedBySignal || timedOut,
        timedOut,
      });
    });
  });
}
