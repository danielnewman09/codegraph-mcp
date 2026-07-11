/**
 * Read steering — opt-in enforcement that agents must use codegraph_* tools
 * before reading source files.  Session-scoped, per-path, bounded.
 *
 * Activated by ``--codegraph-steer-reads true`` (or ``-o codegraph-steer-reads=true``).
 * Off by default.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SOURCE_EXT = /\.(py|ts|tsx|js|jsx|mjs|cjs|cpp|c|cc|h|hpp|hh|rs|go|java|kt|swift|rb|php|cs|scala|clj|ex|exs|erl|hs|ml|fs|vue|svelte|dart|lua|pl|pm|r|jl|zig|nim|v|cr)\b/i;
const SOURCE_SEG = /(^|[\\/])(src|lib|libs|app|internal|pkg|cmd|api|core|services|components|modules|packages)([\\/]|$)/;
const looksLikeSource = (p: string): boolean => SOURCE_EXT.test(p) || SOURCE_SEG.test(p);

const STEER_CAP = 8;
const STEER_REASON =
  "This repository is indexed in a codegraph knowledge graph (Neo4j). " +
  "Before reading source files to understand structure, call graphs, or " +
  "class/method relationships, first call codegraph_explore (action: search/compound/member/callers_callees/inheritance) " +
  "and/or codegraph_query (scope: neighborhood, format: markdown) to retrieve graph context, " +
  "then read files for implementation detail. Re-issue this read afterward. " +
  "(Disable with --no-codegraph-steer-reads or `pi ... -o codegraph-steer-reads=false`.)";

export function registerSteering(pi: ExtensionAPI): void {
  let steerUsedCodegraph = false;
  const steerBlockedPaths = new Set<string>();
  let steerBlockCount = 0;

  pi.on("session_start", () => {
    steerUsedCodegraph = false;
    steerBlockedPaths.clear();
    steerBlockCount = 0;
  });

  pi.on("tool_call", (event) => {
    // Observe codegraph tool usage.
    if (typeof event.toolName === "string" && event.toolName.startsWith("codegraph_")) {
      steerUsedCodegraph = true;
      return;
    }
    // Only steer source-code reads when the flag is on.
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
    process.stderr.write(
      `[codegraph-steer] blocked first source read of ${path} this session — ` +
      `steering to codegraph_* tools (${steerBlockCount}/${STEER_CAP})\n`,
    );
    return { block: true, reason: STEER_REASON };
  });
}
