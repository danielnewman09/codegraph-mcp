/**
 * Canonical tool catalog — the single authoritative definition of every
 * codegraph public tool.
 *
 * One definition per public tool: name, label, description, input schema
 * (JSON-Schema-compatible TypeBox), prompt snippet/guidelines, internal
 * bridge method, timeout class, mutability, and a host-neutral executor
 * that runs against `CodegraphRuntimeLike`.
 *
 * This module must not import Pi or MCP packages.  Both the Pi harness
 * (integrations/pi/pi.ts) and the MCP harness (integrations/codex/mcp.ts) derive
 * their registrations from these definitions.
 */

import { Type } from "typebox";

import type {
  CodegraphRuntimeLike,
  CodegraphToolDefinition,
  JsonObject,
  TimeoutClass,
  ToolResult,
} from "./types.js";
import { SETUP_TIMEOUT_MS, CALL_TIMEOUT_MS } from "./bridge.js";
import { openPath } from "./paths.js";
import { startProgress } from "./progress.js";

// ══════════════════════════════════════════════════════════════════════════
// Schema helpers (host-neutral replacements for Pi's StringEnum)
// ══════════════════════════════════════════════════════════════════════════

/** A string enum schema (`{"type":"string","enum":[...]}`), standard JSON Schema. */
export function stringEnum(
  values: readonly string[],
  options: { description?: string; default?: string } = {},
) {
  return Type.Unsafe({
    type: "string" as const,
    enum: [...values],
    ...(options.description ? { description: options.description } : {}),
    ...(options.default !== undefined ? { default: options.default } : {}),
  });
}

// ══════════════════════════════════════════════════════════════════════════
// Executor helpers
// ══════════════════════════════════════════════════════════════════════════

function fail(label: string, e: unknown): ToolResult {
  const msg = e instanceof Error ? e.message : String(e);
  return { ok: false, text: `${label} failed: ${msg}`, details: { error: msg } };
}

interface SimpleBridgeOpts {
  label: string; // e.g. "codegraph_explore"
  method: string; // e.g. "explore"
  timeoutClass: TimeoutClass;
  /** Prefix for bridge-level errors, e.g. "codegraph error". */
  bridgeErrorPrefix?: string;
  details?: (params: JsonObject) => JsonObject;
}

/**
 * Factory for the common read-only pattern: ensure bridge, check
 * cancellation, call the bridge method, convert the response.
 */
function simpleBridgeExecutor(o: SimpleBridgeOpts): CodegraphToolDefinition["execute"] {
  const bridgeErr = o.bridgeErrorPrefix ?? "codegraph error";
  return async (runtime, params, context) => {
    try {
      if (context.signal?.aborted) return { ok: false, text: `${o.label} aborted before dispatch` };
      const res = await runtime.callClass(o.method, params, o.timeoutClass);
      if (!res.ok) return { ok: false, text: `${bridgeErr}: ${res.error}`, details: { error: res.error } };
      return { ok: true, text: res.text, details: o.details ? o.details(params) : {} };
    } catch (e) {
      return fail(o.label, e);
    }
  };
}

// ══════════════════════════════════════════════════════════════════════════
// codegraph_query
// ══════════════════════════════════════════════════════════════════════════

export const queryTool: CodegraphToolDefinition = {
  name: "codegraph_query",
  label: "Codegraph Query",
  description:
    "Retrieve codebase knowledge-graph context from the codegraph Neo4j store and return it formatted for analysis. " +
    "Use the `scope` field to steer retrieval: 'tag' for an entire design view (design/as-built/dependency), " +
    "'namespace' for a module + everything it composes, 'compound' for a single class/interface/enum, " +
    "'neighborhood' for any node + its 1-hop relationships (the deep-inspection mode), 'source' for a whole " +
    "indexed project, 'kind' to list all nodes of a kind (e.g. all classes), or 'cached' to re-export the last " +
    "fetched graph in a different format without re-querying. " +
    "`format` selects markdown (default, human-readable public API + relationships), plantuml (class diagram), " +
    "component_plantuml (high-level component diagram with requirement annotations), " +
    "json (raw serialized graph), or html (interactive Cytoscape.js visualisation of the neighborhood, opened " +
    "in the browser). Results are cached server-side, so follow an expensive fetch with scope='cached' to switch " +
    "formats for free.",
  promptSnippet: "Fetch codegraph context (by tag/namespace/compound/neighborhood/source/kind) as markdown, plantuml, component_plantuml, json, or interactive HTML",
  promptGuidelines: [
    "Prefer codegraph_query to pull structured codebase context from the graph instead of grepping source.",
    "Start broad with scope='tag' to load an entire view, then scope='neighborhood' + a qualified_name to drill into one symbol.",
    "Use scope='cached' + a different format to re-export the last fetched graph without re-querying Neo4j.",
    "Use format='html' when the user wants to *see* the graph of a code object's neighborhood — it opens an interactive visualisation.",
    "scope='neighborhood' requires a fully-qualified name; use codegraph_explore action='search' first if you don't know it.",
    "For overview/troubleshooting queries (e.g. 'how many tests?'), use codegraph_stats instead of scope='kind' — stats is always compact and won't blow the context window.",
  ],
  inputSchema: Type.Object({
    scope: stringEnum(
      ["tag", "namespace", "compound", "neighborhood", "source", "kind", "cached"],
      {
        description:
          "How to select the subgraph. 'tag' (needs tag), 'namespace'/'compound'/'neighborhood' (need qualified_name), " +
          "'source' (needs source), 'kind' (needs kind, optional tag), 'cached' (reuses the last fetched graph).",
      },
    ),
    format: stringEnum(
      ["markdown", "plantuml", "component_plantuml", "json", "html"],
      {
        description: "Output format. 'markdown' (default): human-readable public API + relationships. 'plantuml': class diagram. 'component_plantuml': high-level component diagram with business-requirement annotations. 'json': raw serialized graph. 'html': interactive Cytoscape visualisation opened in the browser.",
      },
    ),
    qualified_name: Type.Optional(Type.String({
      description: "Fully-qualified name; required for scope=namespace/compound/neighborhood (e.g. 'calc::CalculatorEngine', 'codegraph.graph.LayerGraph').",
    })),
    tag: Type.Optional(Type.String({
      description: "Provenance tag: 'design', 'as-built', 'dependency'. Required for scope=tag; optional filter for scope=kind.",
    })),
    source: Type.Optional(Type.String({
      description: "Source project name (e.g. 'codegraph', 'llvm'). Required for scope=source.",
    })),
    kind: Type.Optional(Type.String({
      description: "Node kind for scope=kind: 'class','struct','interface','enum','union','module','concept','method','attribute','enumvalue','function','define','namespace'.",
    })),
    detail_level: Type.Optional(stringEnum(["high", "medium"], {
      description: "component_plantuml only: 'high' shows component packages + requirement notes only; 'medium' also shows key class names inside packages (default 'high').",
    })),
    min_component_size: Type.Optional(Type.Number({
      description: "component_plantuml only: minimum entities a namespace must contain to be treated as a component (default 2).",
    })),
    public_only: Type.Optional(Type.Boolean({
      description: "markdown only: show only public API members (default true). Set false to include private/protected members.",
    })),
    size: Type.Optional(stringEnum(["large", "small"], {
      description: "html only: layout size. 'large' (default) full-page, 'small' compact.",
    })),
    output: Type.Optional(Type.String({
      description: "html only: custom output HTML path. Defaults to a temp file.",
    })),
    open: Type.Optional(Type.Boolean({
      description: "html only: open the rendered HTML in the default browser (default true).",
    })),
  }),
  bridgeMethod: "query",
  timeoutClass: "normal",
  mutability: "read",
  execute: async (runtime, params, context) => {
    try {
      if (context.signal?.aborted) return { ok: false, text: "codegraph_query aborted before dispatch" };
      const res = await runtime.call("query", params, CALL_TIMEOUT_MS);
      if (!res.ok) return { ok: false, text: `codegraph error: ${res.error}`, details: { error: res.error } };

      const r = res.raw;
      if (r && typeof r === "object" && "html_path" in (r as Record<string, unknown>)) {
        const info = r as { html_path: string; title: string; scope: string; size?: string };
        let opened = false;
        if (context.allowOpenPath && params.open !== false) {
          try { await openPath(info.html_path); opened = true; }
          catch { /* still return the path */ }
        }
        const msg = `Rendered codegraph HTML (${info.scope}${info.title ? `: ${info.title}` : ""}) → ${info.html_path}${opened ? " (opened in browser)" : " (open the file manually)"}`;
        return { ok: true, text: msg, details: { opened, ...info } };
      }

      const text = res.text;
      const scopeVal = params.scope as string;
      let resultText = text;
      if (scopeVal === "kind" && text.length > 30_000) {
        const kindVal = params.kind ?? "?";
        resultText =
          `⚠️  LARGE RESULT (${text.length.toLocaleString()} chars, kind=${kindVal}). ` +
          `Use codegraph_stats for a compact overview instead of fetching all ${kindVal} nodes. ` +
          `Result follows (truncated to first 10KB):\n\n` +
          text.slice(0, 10_240);
      }
      return { ok: true, text: resultText, details: { format: params.format ?? "markdown", scope: scopeVal } };
    } catch (e) {
      return fail("codegraph_query", e);
    }
  },
};

// ══════════════════════════════════════════════════════════════════════════
// codegraph_explore
// ══════════════════════════════════════════════════════════════════════════

export const exploreTool: CodegraphToolDefinition = {
  name: "codegraph_explore",
  label: "Codegraph Explore",
  description:
    "Lightweight lookups against the codegraph store that return slim JSON (not a full serialized graph). " +
    "Use this to *find* symbols and inspect relationships before fetching full context with codegraph_query. " +
    "`action` selects the lookup: 'search' (find compounds by qualified-name substring), 'compound' (a class + its " +
    "member list), 'member' (a single method/attribute), 'namespace' (list compounds under a namespace prefix), " +
    "'namespaces' (list all namespace nodes with entity counts — discover which namespaces are large enough to be components), " +
    "'sources' (list indexed source projects), 'tags' (list available provenance tags + node counts), " +
    "'inheritance' (parents + children of a compound), 'callers_callees' (what calls / is called by a member).",
  promptSnippet: "Look up codegraph symbols & relationships (search, compound, member, namespace, namespaces, inheritance, callers/callees, hlr_subtree, tags, sources)",
  promptGuidelines: [
    "Use codegraph_explore action='search' to find relevant classes by name when you don't yet know the qualified name.",
    "Use action='tags' or 'sources' first to discover what views/projects are indexed before fetching.",
    "Use action='namespaces' to list all namespaces with entity counts — find components without pulling the full graph.",
    "Use action='inheritance' / 'callers_callees' for relationship-specific lookups, then codegraph_query scope='neighborhood' for full context.",
    "Use action='hlr_subtree' with an HLR uid to retrieve the complete requirements tree (HLR → LLRs → tests → scaffold nodes) before decomposing or designing.",
    "These return compact JSON; follow up with codegraph_query to retrieve formatted, complete context for the symbols you found.",
  ],
  inputSchema: Type.Object({
    action: stringEnum(
      ["search", "compound", "member", "namespace", "namespaces", "sources", "tags", "inheritance", "callers_callees", "hlr_subtree"],
      {
        description:
          "search (needs query): find compounds by name substring. compound/member/inheritance/callers_callees (need qualified_name). " +
          "namespace (needs namespace): list compounds under a prefix. sources / tags: list indexed projects / provenance tags. " +
          "hlr_subtree (needs uid): fetch the full requirements subtree (HLR→LLRs→tests→scaffolds).",
      },
    ),
    qualified_name: Type.Optional(Type.String({
      description: "Fully-qualified name; required for action=compound/member/inheritance/callers_callees.",
    })),
    query: Type.Optional(Type.String({
      description: "Substring to search for in compound qualified names (action=search).",
    })),
    namespace: Type.Optional(Type.String({
      description: "Namespace prefix to browse (action=namespace), e.g. 'std', 'codegraph.graph'.",
    })),
    source: Type.Optional(Type.String({
      description: "Filter search results by source project (action=search).",
    })),
    kind: Type.Optional(Type.String({
      description: "Filter search results by node kind, e.g. 'class','interface','enum' (action=search).",
    })),
    tag: Type.Optional(Type.String({
      description: "Optional tag filter (currently unused by explore actions but accepted for forward-compat).",
    })),
    limit: Type.Optional(Type.Number({
      description: "Maximum results for search/namespace (default 30 / 50).",
    })),
    uid: Type.Optional(Type.String({
      description: "HLR uid for action=hlr_subtree.",
    })),
  }),
  bridgeMethod: "explore",
  timeoutClass: "normal",
  mutability: "read",
  execute: simpleBridgeExecutor({
    label: "codegraph_explore",
    method: "explore",
    timeoutClass: "normal",
    details: (params) => ({ action: params.action }),
  }),
};

// ══════════════════════════════════════════════════════════════════════════
// codegraph_tests
// ══════════════════════════════════════════════════════════════════════════

export const testsTool: CodegraphToolDefinition = {
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
  inputSchema: Type.Object({
    action: stringEnum(
      ["list", "detail", "verifies", "covered_by", "modules", "uncovered"],
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
  bridgeMethod: "tests",
  timeoutClass: "normal",
  mutability: "read",
  execute: simpleBridgeExecutor({
    label: "codegraph_tests",
    method: "tests",
    timeoutClass: "normal",
    details: (params) => ({ action: params.action }),
  }),
};

// ══════════════════════════════════════════════════════════════════════════
// codegraph_stats
// ══════════════════════════════════════════════════════════════════════════

export const statsTool: CodegraphToolDefinition = {
  name: "codegraph_stats",
  label: "Codegraph Statistics",
  description:
    "Returns compact, high-level statistics about the codegraph store: total node/relationship counts, " +
    "node counts by kind, source, and tag, description coverage per kind, relationship type breakdown, " +
    "and a test summary. Use this instead of ``codegraph_query scope='kind'`` or ``codegraph_explore action='tags'`` " +
    "when you need a quick overview or are troubleshooting — it's always a few hundred bytes regardless of " +
    "graph size, and will never blow the context window.",
  promptSnippet: "Get high-level graph statistics (counts by kind/source/tag, description coverage, test summary)",
  promptGuidelines: [
    "Use codegraph_stats to get an overview before diving into specific queries. It's always compact.",
    "When troubleshooting (e.g. 'why are test descriptions empty?'), run codegraph_stats first to get the big picture.",
    "codegraph_stats replaces ad-hoc 'show me everything of kind X' queries that can blow context windows.",
  ],
  inputSchema: Type.Object({}),
  bridgeMethod: "stats",
  timeoutClass: "normal",
  mutability: "read",
  execute: simpleBridgeExecutor({
    label: "codegraph_stats",
    method: "stats",
    timeoutClass: "normal",
    bridgeErrorPrefix: "stats error",
    details: () => ({}),
  }),
};

// ══════════════════════════════════════════════════════════════════════════
// codegraph_setup
// ══════════════════════════════════════════════════════════════════════════

export const setupTool: CodegraphToolDefinition = {
  name: "codegraph_setup",
  label: "Codegraph Setup",
  description:
    "Bootstrap and operate the codegraph knowledge graph for a project: provision the Python environment, " +
    "generate the `.doxygen-index.toml` config from the repo's contents, and index source code into the " +
    "active backend (SQLite by default — a plain file, no Docker; pass backend='neo4j' to opt into the " +
    "project-local Neo4j Docker container). Use the `action` field to steer: " +
    "'bootstrap_env' (create/refresh a venv with codegraph + doxygen-index installed — run this first on a new machine), " +
    "'init_config' (auto-detect language/inputs/tests and write `.doxygen-index.toml`), 'index' (parse the project and " +
    "ingest into SQLite (the default), the deprecated legacy Neo4j backend, or JSON; clear defaults to false so it won't wipe existing data — pass clear=true to replace a source), " +
    "'db_start'/'db_stop'/'db_restart'/'db_status' (Neo4j backend only: manage the Docker container), " +
    "'db_backup' (Neo4j backend only: create a dump or tar backup — container is briefly stopped), " +
    "'db_restore' (Neo4j backend only: restore from a backup file — WARNING: destroys current data, safety backup created first), " +
    "'db_backups' (list available backup files with size and timestamp), " +
    "'bootstrap' (one-shot: init_config → index, with clear=true; db_start only for the deprecated backend='neo4j'), or " +
    "'status' (bridge + backend + tags health).",
  promptSnippet: "Provision env, create .doxygen-index.toml, and index a project into the codegraph (SQLite by default, Neo4j optional)",
  promptGuidelines: [
    "DESTRUCTIVE: action='index' and action='bootstrap' re-index a project and can REPLACE existing graph data for that source. Only run them when the user EXPLICITLY asks to (re)index or bootstrap a project — never as a shortcut to 'explore' or 'set up the graph' when asked to read or understand code.",
    "On a fresh machine, call codegraph_setup action='bootstrap_env' once before anything else — it creates a venv with codegraph + doxygen-index.",
    "The default backend is SQLite (a plain file — no Docker, no container to manage). Neo4j is a deprecated legacy backend; only use db_* actions and backend='neo4j' when explicitly requested.",
    "Use action='db_backup' (Neo4j backend only) to create a backup before risky operations like re-indexing with clear=true. Pass mode='tar' for speed or mode='dump' (default) for portability.",
    "Use action='db_backups' to list available backup files before restoring.",
    "DESTRUCTIVE: action='db_restore' replaces the entire database from a backup file. A safety backup is created automatically first. Only run when the user explicitly asks to restore.",
    "To graph a new project end-to-end: codegraph_setup action='bootstrap' with project_dir — it writes the config and indexes (Docker/Neo4j only when backend='neo4j').",
    "Use action='init_config' to generate/refresh `.doxygen-index.toml` from a repo (auto-detects C++ vs Python, input/test paths, project name).",
    "Neo4j backend only: use action='db_start' before action='index' with format='neo4j'; action='db_status' checks the container.",
    "After indexing, switch to codegraph_query / codegraph_explore / codegraph_tests to retrieve the graph context you just created.",
  ],
  inputSchema: Type.Object({
    action: stringEnum(
      ["bootstrap_env", "init_config", "index", "db_start", "db_stop", "db_restart", "db_status", "db_backup", "db_restore", "db_backups", "bootstrap", "status"],
      { description: "Which setup operation to perform (see tool description)." },
    ),
    project_dir: Type.Optional(Type.String({
      description: "Project directory. Required for init_config/index/db_*/bootstrap; optional for status. Defaults to cwd.",
    })),
    language: Type.Optional(stringEnum(["cpp", "python"], {
      description: "init_config: override auto-detected language.",
    })),
    name: Type.Optional(Type.String({ description: "init_config: override auto-detected project name." })),
    input_paths: Type.Optional(Type.Array(Type.String(), {
      description: "init_config: override auto-detected source input paths (e.g. ['src'] or ['include','src']).",
    })),
    test_paths: Type.Optional(Type.Array(Type.String(), {
      description: "init_config: override auto-detected test directories (Python only).",
    })),
    backend: Type.Optional(stringEnum(["sqlite", "neo4j"], {
      description: "index/bootstrap: override the graph backend for this run ('sqlite' default — plain file, no Docker; 'neo4j' — project-local Docker container).",
    })),
    format: Type.Optional(stringEnum(["sqlite", "json", "neo4j"], {
      description: "index: output target. 'sqlite' is the default; 'json' writes a JSON file; 'neo4j' selects the deprecated legacy Neo4j backend.",
    })),
    html: Type.Optional(Type.Boolean({
      description: "init_config: include a [codegraph-html] section so doxygen-index also emits an interactive HTML graph (default true).",
    })),
    force: Type.Optional(Type.Boolean({
      description: "init_config: overwrite an existing .doxygen-index.toml (default false — returns the existing one instead).",
    })),
    clear: Type.Optional(Type.Boolean({
      description: "index: clear existing data for this source before ingesting into the graph (default false — won't wipe existing data; pass true to replace a source).",
    })),
    source: Type.Optional(Type.String({ description: "index: source provenance label (default: project name from config)." })),
    output_dir: Type.Optional(Type.String({ description: "index: override output directory." })),
    timeout: Type.Optional(Type.Number({
      description: "index/db_*: per-command timeout in seconds (default 600 for index, 120 for db).",
    })),
    mode: Type.Optional(stringEnum(["dump", "tar"], {
      description: "db_backup only: backup mode. 'dump' (default): logical neo4j-admin dump producing a portable .dump file. 'tar': fast filesystem-level tar.gz of the data directory.",
    })),
    keep: Type.Optional(Type.Number({
      description: "db_backup only: retention — keep only the last N backup files of the same mode, deleting older ones.",
    })),
    backup_file: Type.Optional(Type.String({
      description: "db_restore only: path to the backup file to restore. If omitted, lists available backups instead of restoring.",
    })),
    codegraph_source: Type.Optional(Type.String({
      description: "bootstrap_env: pip spec or local path for codegraph (default: flag --codegraph-source or 'codegraph').",
    })),
    doxygen_index_source: Type.Optional(Type.String({
      description: "bootstrap_env: pip spec or local path for doxygen-index (default: flag --doxygen-index-source or 'doxygen-index').",
    })),
  }),
  bridgeMethod: "setup",
  timeoutClass: "setup",
  mutability: "mixed",
  execute: async (runtime, params, context) => {
    try {
      if (context.signal?.aborted) return { ok: false, text: "codegraph_setup aborted before dispatch" };
      if (params.action === "bootstrap_env") {
        return runtime.bootstrapEnv(params);
      }
      const tmo = params.action === "index" || params.action === "bootstrap"
        ? SETUP_TIMEOUT_MS : 180_000;
      const res = await runtime.call("setup", params, tmo);
      if (!res.ok) return { ok: false, text: `codegraph setup error: ${res.error}`, details: { error: res.error } };
      return { ok: true, text: res.text, details: { action: params.action, raw: res.raw } };
    } catch (e) {
      return fail("codegraph_setup", e);
    }
  },
};

// ══════════════════════════════════════════════════════════════════════════
// codegraph_discover
// ══════════════════════════════════════════════════════════════════════════

export const discoverTool: CodegraphToolDefinition = {
  name: "codegraph_discover",
  label: "Codegraph Discover",
  description:
    "Discover existing requirements (HLRs/LLRs) and related code before designing a new feature. " +
    "Actions: search_requirements (keyword search), get_hlr_dependencies (DEPENDS_ON traversal), " +
    "list_requirements (browse by component/tag), get_requirement_traces (requirement → code links), " +
    "build_design_context (assemble full context document for design agent). " +
    "Use this BEFORE designing to understand what already exists.",
  promptSnippet: "Discover existing requirements & code before designing (search_requirements, get_hlr_dependencies, list_requirements, get_requirement_traces, build_design_context)",
  promptGuidelines: [
    "Call codegraph_discover action='build_design_context' with a feature description to get a structured context document for design.",
    "Use action='search_requirements' to find related HLRs/LLRs by keyword before designing a new feature.",
    "Use action='get_hlr_dependencies' to find which HLRs a requirement depends on (DEPENDS_ON edges).",
    "codegraph_discover complements codegraph_query and codegraph_explore: discover finds requirements, query/explore find code.",
  ],
  inputSchema: Type.Object({
    action: stringEnum(
      ["search_requirements", "get_hlr_dependencies", "list_requirements", "get_requirement_traces", "build_design_context", "ingest_design", "generate_hlr_docs", "generate_feedback_docs", "evaluate_coverage", "verify_callee_granularity"],
      {
        description:
          "search_requirements (needs query): keyword search across HLR/LLR descriptions. " +
          "get_hlr_dependencies (needs uid): traverse DEPENDS_ON edges from an HLR. " +
          "list_requirements (optional component_name/tag): browse all HLRs. " +
          "get_requirement_traces (needs uid): requirement → design node COMPOSES edges. " +
          "build_design_context (needs feature_description): assemble full context document. " +
          "ingest_design (needs file_path): ingest a design/tests markdown file into Neo4j. " +
          "generate_hlr_docs: generate per-HLR documents from Neo4j. " +
          "generate_feedback_docs: generate feedback review documents. " +
          "evaluate_coverage: evaluate test coverage and design smells. " +
          "verify_callee_granularity: verify CALLEE edges target correct level.",
      },
    ),
    query: Type.Optional(Type.String({
      description: "Search text for action=search_requirements.",
    })),
    scope: Type.Optional(Type.String({
      description: "Search scope for action=search_requirements: 'hlr', 'llr', or 'both' (default both).",
    })),
    limit: Type.Optional(Type.Number({
      description: "Max results for action=search_requirements (default 20).",
    })),
    uid: Type.Optional(Type.String({
      description: "HLR or LLR uid for action=get_hlr_dependencies or action=get_requirement_traces.",
    })),
    direction: Type.Optional(Type.String({
      description: "Traversal direction for action=get_hlr_dependencies: 'outgoing', 'incoming', or 'both' (default outgoing).",
    })),
    component_name: Type.Optional(Type.String({
      description: "Component name filter for action=list_requirements or action=build_design_context.",
    })),
    tag: Type.Optional(Type.String({
      description: "Tag filter for action=list_requirements (e.g. 'design', 'as-built').",
    })),
    feature_description: Type.Optional(Type.String({
      description: "Feature description for action=build_design_context.",
    })),
    file_path: Type.Optional(Type.String({
      description: "Path to markdown file for action=ingest_design.",
    })),
    output_path: Type.Optional(Type.String({
      description: "Output path for action=evaluate_coverage (JSON report).",
    })),
  }),
  bridgeMethod: "discover",
  timeoutClass: "normal",
  mutability: "read",
  execute: simpleBridgeExecutor({
    label: "codegraph_discover",
    method: "discover",
    timeoutClass: "normal",
    bridgeErrorPrefix: "codegraph_discover error",
    details: (params) => ({ action: params.action }),
  }),
};

// ══════════════════════════════════════════════════════════════════════════
// codegraph_decompose
// ══════════════════════════════════════════════════════════════════════════

export const decomposeTool: CodegraphToolDefinition = {
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
  inputSchema: Type.Object({
    hlr_uid: Type.Optional(Type.String({
      description: "The HLR uid (hex UUID) to load from Neo4j, decompose, and persist.",
    })),
    qualified_name: Type.Optional(Type.String({
      description: "Fully-qualified name of the HLR (e.g. 'Architecture Diagram Generator'). Used as the slug for output files.",
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
  bridgeMethod: "decompose_run",
  timeoutClass: "agent",
  mutability: "write",
  execute: async (runtime, params, context) => {
    const onProgress = context.onProgress;
    const progress = startProgress(
      onProgress ? (partial) => onProgress(partial.content[0].text, partial.details) : undefined,
      "Decomposing HLR…",
    );
    try {
      if (context.signal?.aborted) return { ok: false, text: "codegraph_decompose aborted before dispatch" };
      const res = await runtime.call("decompose_run", params, 300_000);
      if (!res.ok) return { ok: false, text: `codegraph_decompose error: ${res.error}`, details: { error: res.error } };
      return { ok: true, text: res.text, details: {} };
    } catch (e) {
      return fail("codegraph_decompose", e);
    } finally {
      progress.stop();
    }
  },
};

// ══════════════════════════════════════════════════════════════════════════
// codegraph_design
// ══════════════════════════════════════════════════════════════════════════

export const designTool: CodegraphToolDefinition = {
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
  inputSchema: Type.Object({
    hlr_uid: Type.Optional(Type.String({
      description: "The HLR uid (hex UUID) to load from Neo4j, design, and persist.",
    })),
    log_dir: Type.Optional(Type.String({
      description: "Directory for per-step prompt logs.",
    })),
  }),
  bridgeMethod: "design_run",
  timeoutClass: "agent",
  mutability: "write",
  execute: async (runtime, params, context) => {
    const onProgress = context.onProgress;
    const progress = startProgress(
      onProgress ? (partial) => onProgress(partial.content[0].text, partial.details) : undefined,
      "Designing OO classes…",
    );
    try {
      if (context.signal?.aborted) return { ok: false, text: "codegraph_design aborted before dispatch" };
      const res = await runtime.call("design_run", params, 600_000);
      if (!res.ok) return { ok: false, text: `codegraph_design error: ${res.error}`, details: { error: res.error } };
      return { ok: true, text: res.text, details: {} };
    } catch (e) {
      return fail("codegraph_design", e);
    } finally {
      progress.stop();
    }
  },
};

// ══════════════════════════════════════════════════════════════════════════
// codegraph_memory
// ══════════════════════════════════════════════════════════════════════════

export const memoryTool: CodegraphToolDefinition = {
  name: "codegraph_memory",
  label: "Codegraph Memory",
  description:
    "Manage design memory nodes (decisions, constraints, rationales, assumptions, " +
    "tradeoffs, insights) linked to codebase knowledge graphs. " +
    "Actions: 'record' to create/update memory nodes and link them to code; " +
    "'context' to fetch all design memory relevant to a code node (including inherited " +
    "context from COMPOSES ancestors); 'lookup' for targeted queries (memory_of, " +
    "constraints_for, decision_chain, insights_for, rationales_for, assumptions_for, " +
    "tradeoffs_for, affected_decisions); 'search' for full-text search across all " +
    "memory content; 'search_semantic' for vector similarity search.",
  promptSnippet: "Manage design memory — record decisions/constraints/rationales and query design rationale linked to code nodes",
  promptGuidelines: [
    "Use action='record' to create or update memory nodes — decisions, constraints, rationales, assumptions, tradeoffs, insights.",
    "Use action='context' before modifying code to see all design rationale, constraints, and decisions affecting a code node.",
    "Use action='lookup' with lookup_type='constraints_for' or 'decision_chain' for targeted queries.",
    "Use action='search' to find memories by keyword across the full store.",
    "When recording a decision, use 'supersedes' to mark older decisions as replaced.",
    "Use 'links_to' to associate memories with code nodes by qualified_name.",
  ],
  inputSchema: Type.Object({
    action: stringEnum(
      ["record", "context", "lookup", "search", "search_semantic"],
      {
        description: "Which memory operation to perform. 'record': create/update a memory node. 'context': fetch all design memory relevant to a code node. 'lookup': targeted queries (needs lookup_type). 'search': full-text search. 'search_semantic': vector similarity search.",
      },
    ),
    qualified_name: Type.Optional(Type.String({
      description: "Qualified name of the target entity. For 'record': the memory node's qualified_name (e.g. 'memory::db-choice'). For 'context'/'lookup': the code node's qualified_name.",
    })),
    memory_type: Type.Optional(stringEnum(
      ["decision", "constraint", "rationale", "assumption", "tradeoff", "insight"],
      {
        description: "Memory node type (action='record'). One of: decision, constraint, rationale, assumption, tradeoff, insight.",
      },
    )),
    content: Type.Optional(Type.String({
      description: "Free-text body of the memory (action='record').",
    })),
    tags: Type.Optional(Type.Array(Type.String(), {
      description: "Provenance tags (action='record'), e.g. ['design', 'as-built']. Replaces existing tags on update.",
    })),
    confidence: Type.Optional(Type.Number({
      description: "Confidence 0.0–1.0 (action='record').",
    })),
    source: Type.Optional(Type.String({
      description: "Source project name (action='record').",
    })),
    links_to: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], {
      description: "qualified_name(s) of code nodes to link this memory to (action='record'). Additive — adds new links.",
    })),
    supersedes: Type.Optional(Type.String({
      description: "qualified_name of an older DecisionNode to supersede (action='record', memory_type='decision' only).",
    })),
    refines: Type.Optional(Type.String({
      description: "qualified_name of a DecisionNode this Rationale elaborates (action='record', memory_type='rationale' only).",
    })),
    contradicts: Type.Optional(Type.String({
      description: "qualified_name of an AssumptionNode this contradicts (action='record', memory_type='assumption' only).",
    })),
    mode: Type.Optional(stringEnum(
      ["create", "update", "upsert"],
      {
        description: "Creation mode (action='record'). 'upsert' (default): update if exists, create if not. 'create': always create new. 'update': error if not found.",
      },
    )),
    uid: Type.Optional(Type.String({
      description: "Precise targeting by UID (action='record'). Overrides qualified_name lookup.",
    })),
    traverse_parents: Type.Optional(Type.Boolean({
      description: "If true (default), walk COMPOSES upward to include memories from parent nodes (action='context').",
    })),
    max_depth: Type.Optional(Type.Number({
      description: "Maximum COMPOSES traversal depth (action='context'). Default 5.",
    })),
    include_superseded: Type.Optional(Type.Boolean({
      description: "If true, include superseded decisions in results (action='context'). Default false.",
    })),
    lookup_type: Type.Optional(stringEnum(
      ["memory_of", "constraints_for", "decision_chain", "insights_for",
       "rationales_for", "assumptions_for", "tradeoffs_for", "affected_decisions"],
      {
        description: "Specific lookup type (action='lookup'). memory_of: all memories for a code node. constraints_for: constraints governing a node. decision_chain: decisions + SUPERSEDES chain. insights_for/rationales_for/assumptions_for/tradeoffs_for: filtered lookups. affected_decisions: memories for a node and all its COMPOSES descendants.",
      },
    )),
    query: Type.Optional(Type.String({
      description: "Search query string (action='search'). Searches memory content and qualified_names.",
    })),
    limit: Type.Optional(Type.Number({
      description: "Maximum results to return (action='search' default 20, action='search_semantic' default 10).",
    })),
    tag: Type.Optional(Type.String({
      description: "Optional tag filter for search (action='search'/'search_semantic'), e.g. 'design'.",
    })),
    embedding: Type.Optional(Type.Array(Type.Number(), {
      description: "1536-dimensional embedding vector for semantic search (action='search_semantic').",
    })),
  }),
  bridgeMethod: "memory",
  timeoutClass: "normal",
  mutability: "mixed",
  execute: simpleBridgeExecutor({
    label: "codegraph_memory",
    method: "memory",
    timeoutClass: "normal",
    bridgeErrorPrefix: "codegraph_memory error",
    details: (params) => ({ action: params.action }),
  }),
};

// ══════════════════════════════════════════════════════════════════════════
// Catalog accessors
// ══════════════════════════════════════════════════════════════════════════

export const ALL_TOOLS: CodegraphToolDefinition[] = [
  queryTool,
  exploreTool,
  testsTool,
  statsTool,
  setupTool,
  discoverTool,
  decomposeTool,
  designTool,
  memoryTool,
];

export function findTool(name: string): CodegraphToolDefinition | undefined {
  return ALL_TOOLS.find((t) => t.name === name);
}

/** Deep-copy a tool's input schema to a plain JSON Schema object (for MCP). */
export function toolInputJsonSchema(def: CodegraphToolDefinition): JsonObject {
  return JSON.parse(JSON.stringify(def.inputSchema)) as JsonObject;
}
