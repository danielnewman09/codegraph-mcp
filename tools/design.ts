/**
 * codegraph_design — OO class design with verification stub resolution.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { CodegraphBridge } from "../shared.js";
import { ok, err, startProgress } from "../shared.js";

export function registerDesignTool(
  pi: ExtensionAPI,
  deps: { ensureBridge: () => Promise<CodegraphBridge> },
): void {
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
      "Pass 'hlr_uid' to design an existing HLR from Neo4j.",
      "After design, run codegraph_discover action='generate_hlr_docs' to export readable documents.",
      "Then use codegraph_discover action='generate_feedback_docs' to create review templates.",
      "This tool runs an LLM agent internally — it may take 60-300 seconds.",
    ],
    parameters: Type.Object({
      hlr_uid: Type.Optional(Type.String({
        description: "The HLR uid (hex UUID) to load from Neo4j, design, and persist.",
      })),
      log_dir: Type.Optional(Type.String({
        description: "Directory for per-step prompt logs.",
      })),
    }),
    renderCall(args, _theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const uid = (args as { hlr_uid?: string }).hlr_uid;
      text.setText(`codegraph_design  ${uid ? `HLR ${uid.slice(0, 8)}` : ""}`);
      return text;
    },
    async execute(_id, params, signal, onUpdate) {
      const progress = startProgress(onUpdate, "Designing OO classes…");
      try {
        const b = await deps.ensureBridge();
        if (signal?.aborted) return err("codegraph_design aborted before dispatch");
        const res = await b.call("design_run", params as Record<string, unknown>, 600_000);
        if (!res.ok) return err(`codegraph_design error: ${res.error}`, { error: res.error });
        const r = res.result;
        const text = typeof r === "string" ? r : JSON.stringify(r, null, 2);
        return ok(text, {});
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`codegraph_design failed: ${msg}`, { error: msg });
      } finally {
        progress.stop();
      }
    },
  });
}
