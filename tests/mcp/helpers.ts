/**
 * Shared test helpers — spawned-stdio MCP server client.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const MCP_ENTRY = join(__dirname, "..", "..", "src", "harnesses", "mcp.ts");
export const FAKE_BRIDGE = join(__dirname, "..", "fixtures", "fake-bridge.mjs");

/** Minimal Transport over a manually-spawned child process. */
export class SpawnedStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  child: ChildProcess;
  private buffer = "";

  constructor(child: ChildProcess) {
    this.child = child;
  }

  async start(): Promise<void> {
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        try { this.onmessage?.(JSON.parse(line)); } catch { /* ignore */ }
      }
    });
    this.child.stderr!.setEncoding("utf8");
    this.child.stderr!.on("data", () => { /* diagnostics; discard in tests */ });
    this.child.on("exit", () => this.onclose?.());
    this.child.on("error", (e) => this.onerror?.(e));
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.child.stdin!.write(JSON.stringify(message) + "\n");
  }

  async close(): Promise<void> {
    try { this.child.stdin!.end(); } catch { /* ignore */ }
    await this.waitForExit(5_000);
  }

  async waitForExit(ms: number): Promise<number | null> {
    if (this.child.exitCode !== null) return this.child.exitCode;
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(this.child.exitCode), ms);
      this.child.once("exit", () => { clearTimeout(t); resolve(this.child.exitCode); });
    });
  }
}

/** Spawn the MCP server with extra env and connect an SDK client. */
export async function startServer(
  extraEnv: Record<string, string> = {},
): Promise<{ client: Client; transport: SpawnedStdioTransport }> {
  const child = spawn(process.execPath, ["--import", "tsx", MCP_ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...extraEnv },
  });
  const transport = new SpawnedStdioTransport(child);
  const client = new Client({ name: "codegraph-test-client", version: "0.0.0" });
  await client.connect(transport);
  return { client, transport };
}
