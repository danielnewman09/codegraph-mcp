/**
 * codegraph_decompose — decompose an HLR into LLRs with verification stubs.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { CodegraphBridge } from "../shared.js";
import { ok, err, startProgress } from "../shared.js";

export function registerDecomposeTool(
  pi: ExtensionAPI,
  deps: { ensureBridge: () => Promise<CodegraphBridge> },
): void {
  pi.registerTool({
    name: "codegraph_decompose",
    label: "Codegraph Decompose",
    description:
      "Run the decompose_hlr agent to break down a high-level requirement (HLR) into low-level requirements (LLRs) " +
      "with verification stubs. Accepts either a Neo4j HLR uid (loads from the graph, decomposes, persists) " +
      "or a raw description string (decomposes only, no persistence). " +
      "When an HLR uid is provided, the agent automatically loads the existing requirements tree " +
      "(existing LLRs, tests, scaffold nodes) and completes gaps rather than starting from scratch — " +
      "it fills in missing tests, assertions, and steps for partially complete requirements. " +
      "Returns the flat list of codegraph node dicts (LLRs, TestNodes, AssertionNodes, TestStepNodes) " +
      "or a summary of persisted results. This is a heavy, long-running tool (makes LLM API calls).",
    promptSnippet: "Decompose an HLR into LLRs with verification stubs — fills in gaps for partially complete requirements",
    promptGuidelines: [
      "Use codegraph_decompose to decompose a high-level requirement into low-level requirements with test stubs.",
      "Pass 'hlr_uid' to decompose an existing HLR from Neo4j; pass 'description' to decompose a raw description.",
      "After decomposition, use codegraph_design to produce the OO class design.",
      "This tool runs an LLM agent internally — it may take 30-120 seconds.",
    ],
    parameters: Type.Object({
      hlr_uid: Type.Optional(Type.String({
        description: "The HLR uid (hex UUID) to load from Neo4j, decompose, and persist.",
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
    renderCall(args, _theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const hlr = (args as { hlr_uid?: string; description?: string })
      const target = hlr.hlr_uid ? `HLR ${hlr.hlr_uid.slice(0, 8)}` : hlr.description ? hlr.description.slice(0, 60) : "";
      text.setText(`codegraph_decompose  ${target}`);
      return text;
    },
    async execute(_id, params, signal, onUpdate) {
      const progress = startProgress(onUpdate, "Decomposing HLR…");
      try {
        const b = await deps.ensureBridge();
        if (signal?.aborted) return err("codegraph_decompose aborted before dispatch");
        const res = await b.call("decompose_run", params as Record<string, unknown>, 300_000);
        if (!res.ok) return err(`codegraph_decompose error: ${res.error}`, { error: res.error });
        const r = res.result;
        const text = typeof r === "string" ? r : JSON.stringify(r, null, 2);
        return ok(text, {});
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`codegraph_decompose failed: ${msg}`, { error: msg });
      } finally {
        progress.stop();
      }
    },
  });
}
