/**
 * shared — compatibility facade for the codegraph Pi extension.
 *
 * Re-exports the host-neutral core (bridge, config, results, progress,
 * paths) with the same names the existing Pi tools and index.ts import,
 * plus preserved constants and a Pi-compatible `openPath(pi, target)`.
 *
 * New code should import from `./src/core/*` directly; this file exists
 * so the existing Pi layer can migrate incrementally.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Core re-exports ───────────────────────────────────────────────────────

export {
  CodegraphBridge,
  CALL_TIMEOUT_MS,
  SETUP_TIMEOUT_MS,
  WIN,
  type BridgeResponse,
} from "./src/core/bridge.js";

export { DEFAULT_BRIDGE } from "./src/core/config.js";
export { ok, err, tail } from "./src/core/results.js";
export { startProgress, type ProgressHandle } from "./src/core/progress.js";

import { openPath as openPathCore } from "./src/core/paths.js";
export { openPath as openPathCore } from "./src/core/paths.js";

// ── Preserved Pi defaults (historical constants) ──────────────────────────
//
// The core exposes path *resolvers*; these constants preserve the exact
// historical values so existing tool code and tests keep compiling.

/** Historical default venv location: ~/.pi/agent/codegraph/venv. */
export const DEFAULT_VENV = join(homedir(), ".pi", "agent", "codegraph", "venv");

/** Historical config directory: ~/.pi/agent/codegraph. */
export const CONFIG_DIR = join(homedir(), ".pi", "agent", "codegraph");

/** Historical config file: ~/.pi/agent/codegraph/config.json. */
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");

// ── Pi-compatible openPath ────────────────────────────────────────────────

/**
 * Open a path with the platform default viewer.  `pi` is accepted for
 * backward compatibility but unused; opening goes through the
 * host-neutral `openPathCore`.
 */
export async function openPath(pi: ExtensionAPI, target: string): Promise<void> {
  void pi;
  await openPathCore(target);
}
