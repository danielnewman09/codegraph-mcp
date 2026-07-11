/**
 * codegraph_tests — test-focused exploration of the codegraph store.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { CodegraphBridge } from "../shared.js";
import { ok, err } from "../shared.js";

export function registerTestsTool(
  pi: ExtensionAPI,
  deps: { ensureBridge: () => Promise<CodegraphBridge> },
): void {
  pi.registerTool({
    name: "codegraph_tests",
    label: "Codegraph Tests",
    description:
      "Test-focused exploration of the codegraph store, returning slim JSON. The store indexes tests (from `test_paths`) as `test` / `test_step` / `test_fixture` / `assertion` nodes linked to the code under test by `VERIFIES` (test → method/class) and `CALLEE` (test_step → called code). `action` selects the lookup: 'list' (all tests, filterable by source/module/tag, with the code each test verifies), 'modules' (tests grouped by test module), 'verifies' (given a test, the code it exercises), 'covered_by' (given a code node, the tests that verify it — including tests of a class's members, i.e. a coverage view; set detail=true to inline descriptions + step/fixture/assertion counts), 'detail' (one test: its verifies targets, steps with callees, fixtures, assertions), 'uncovered' (given a qualified_name prefix or source, returns classes/structs/interfaces/enums/unions with zero VERIFIES edges — the negative space of coverage). For a visual graph of a test's neighborhood, use codegraph_query scope='neighborhood' with the test's qualified_name.",
    promptSnippet: "Explore indexed tests: list tests, what a test verifies, what tests cover a given class/method, test detail (steps/fixtures/assertions)",
    promptGuidelines: [
      "Use action='list' (optionally with source/test_module) to see all indexed tests and how many code nodes each verifies.",
      "Use action='covered_by' with a class or method qualified_name to answer 'which tests cover this code?' — it includes tests of a class's members.",
      "Use action='verifies' with a test qualified_name to see exactly which code a test exercises; action='detail' for the full breakdown (steps, callees, fixtures, assertions).",
      "Pass detail=true with covered_by to inline each test's description and step/fixture/assertion counts — one call instead of N detail calls.",
      "Use action='uncovered' with a qualified_name prefix (e.g. 'codegraph.models.test') to find classes with zero test coverage — the negative space.",
      "These return compact JSON; for a rendered graph of a test's neighborhood use codegraph_query scope='neighborhood' with the test's qualified_name.",
    ],
    parameters: Type.Object({
      action: StringEnum(
        ["list", "detail", "verifies", "covered_by", "modules", "uncovered"] as const,
        {
          description:
            "list (optional source/test_module/tag filter): all tests + verifies counts. modules: tests grouped by test_module. " +
            "list (optional source/test_module/tag): all tests + verifies counts. modules: tests grouped by test_module. " +
            "verifies (needs qualified_name of a test): code it exercises. covered_by (needs qualified_name of a code node): tests that verify it (+ member tests). " +
            "detail (needs qualified_name of a test): verifies + steps(with callees) + fixtures + assertions. " +
            "uncovered (needs qualified_name prefix or source): classes/interfaces/enums/unions/structs with zero tests.",
        },
      ),
      qualified_name: Type.Optional(Type.String({
        description: "Test qualified_name (for action=verifies/detail) or code-node qualified_name (for action=covered_by). For action=uncovered, a namespace prefix (e.g. 'codegraph.models.test') to scope the negative-coverage search.",
      })),
      source: Type.Optional(Type.String({
        description: "Filter by source project (action=list/modules).",
      })),
      test_module: Type.Optional(Type.String({
        description: "Filter by test module, e.g. 'test_calculator' (action=list/modules).",
      })),
      tag: Type.Optional(Type.String({
        description: "Filter by provenance tag (action=list/modules).",
      })),
      limit: Type.Optional(Type.Number({
        description: "Maximum tests to return for action=list (default 100).",
      })),
      detail: Type.Optional(Type.Boolean({
        description: "For action=covered_by: when true, inlines each test's description and step/fixture/assertion counts into the result entries.",
      })),
    }),
    renderCall(args, _theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const p = args as { action?: string; qualified_name?: string; source?: string };
      const target = p.qualified_name ?? p.source ?? "";
      text.setText(["codegraph_tests", p.action ?? "", target].filter(Boolean).join("  "));
      return text;
    },
    async execute(_id, params, signal) {
      try {
        const b = await deps.ensureBridge();
        if (signal?.aborted) return err("codegraph_tests aborted before dispatch");
        const res = await b.call("tests", params as Record<string, unknown>);
        if (!res.ok) return err(`codegraph error: ${res.error}`, { error: res.error });
        const r = res.result;
        const text = typeof r === "string" ? r : JSON.stringify(r, null, 2);
        return ok(text, { action: params.action });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`codegraph_tests failed: ${msg}`, { error: msg });
      }
    },
  });
}
