/**
 * codegraph_setup — bootstrap, config, indexing, backend lifecycle.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { CodegraphBridge } from "../shared.js";
import { ok, err, tail, SETUP_TIMEOUT_MS } from "../shared.js";

export function registerSetupTool(
  pi: ExtensionAPI,
  deps: {
    ensureBridge: () => Promise<CodegraphBridge>;
    bootstrapEnv: (params: Record<string, unknown>) => Promise<ReturnType<typeof ok> | ReturnType<typeof err>>;
  },
): void {
  pi.registerTool({
    name: "codegraph_setup",
    label: "Codegraph Setup",
    description:
      "Bootstrap and operate the codegraph knowledge graph for a project: provision the Python environment, " +
      "generate the `.doxygen-index.toml` config from the repo's contents, and index source code into the " +
      "active backend (SQLite by default — a plain file, no Docker; pass backend='neo4j' to opt into the " +
      "project-local Neo4j Docker container). Use the `action` field to steer: " +
      "'bootstrap_env' (create/refresh a venv with codegraph + doxygen-index installed — run this first on a new machine), " +
      "'init_config' (auto-detect language/inputs/tests and write `.doxygen-index.toml`), 'index' (parse the project and " +
      "ingest into the graph backend or JSON; clear defaults to false so it won't wipe existing data — pass clear=true to replace a source), " +
      "'db_start'/'db_stop'/'db_restart'/'db_status' (Neo4j backend only: manage the Docker container), " +
      "'db_backup' (Neo4j backend only: create a dump or tar backup — container is briefly stopped), " +
      "'db_restore' (Neo4j backend only: restore from a backup file — WARNING: destroys current data, safety backup created first), " +
      "'db_backups' (list available backup files with size and timestamp), " +
      "'bootstrap' (one-shot: init_config → index, with clear=true; db_start only when backend='neo4j'), or " +
      "'status' (bridge + backend + tags health).",
    promptSnippet: "Provision env, create .doxygen-index.toml, and index a project into the codegraph (SQLite by default, Neo4j optional)",
    promptGuidelines: [
      "DESTRUCTIVE: action='index' and action='bootstrap' re-index a project and can REPLACE existing graph data for that source. Only run them when the user EXPLICITLY asks to (re)index or bootstrap a project — never as a shortcut to 'explore' or 'set up the graph' when asked to read or understand code.",
      "On a fresh machine, call codegraph_setup action='bootstrap_env' once before anything else — it creates a venv with codegraph + doxygen-index.",
      "The default backend is SQLite (a plain file — no Docker, no container to manage). Only use the db_* actions and backend='neo4j' when the user explicitly wants the Neo4j/Docker flow.",
      "Use action='db_backup' (Neo4j backend only) to create a backup before risky operations like re-indexing with clear=true. Pass mode='tar' for speed or mode='dump' (default) for portability.",
      "Use action='db_backups' to list available backup files before restoring.",
      "DESTRUCTIVE: action='db_restore' replaces the entire database from a backup file. A safety backup is created automatically first. Only run when the user explicitly asks to restore.",
      "To graph a new project end-to-end: codegraph_setup action='bootstrap' with project_dir — it writes the config and indexes (Docker/Neo4j only when backend='neo4j').",
      "Use action='init_config' to generate/refresh `.doxygen-index.toml` from a repo (auto-detects C++ vs Python, input/test paths, project name).",
      "Neo4j backend only: use action='db_start' before action='index' with format='neo4j'; action='db_status' checks the container.",
      "After indexing, switch to codegraph_query / codegraph_explore / codegraph_tests to retrieve the graph context you just created.",
    ],
    parameters: Type.Object({
      action: StringEnum(
        ["bootstrap_env", "init_config", "index", "db_start", "db_stop", "db_restart", "db_status", "db_backup", "db_restore", "db_backups", "bootstrap", "status"] as const,
        { description: "Which setup operation to perform (see tool description)." },
      ),
      project_dir: Type.Optional(Type.String({
        description: "Project directory. Required for init_config/index/db_*/bootstrap; optional for status. Defaults to cwd.",
      })),
      language: Type.Optional(StringEnum(["cpp", "python"] as const, {
        description: "init_config: override auto-detected language.",
      })),
      name: Type.Optional(Type.String({ description: "init_config: override auto-detected project name." })),
      input_paths: Type.Optional(Type.Array(Type.String(), {
        description: "init_config: override auto-detected source input paths (e.g. ['src'] or ['include','src']).",
      })),
      test_paths: Type.Optional(Type.Array(Type.String(), {
        description: "init_config: override auto-detected test directories (Python only).",
      })),
      backend: Type.Optional(StringEnum(["sqlite", "neo4j"] as const, {
        description: "index/bootstrap: override the graph backend for this run ('sqlite' default — plain file, no Docker; 'neo4j' — project-local Docker container).",
      })),
      format: Type.Optional(StringEnum(["neo4j", "json"] as const, {
        description: "index: output format. 'neo4j' (default) ingests into the active graph backend (SQLite by default); 'json' writes a JSON file (and HTML if [codegraph-html] is configured).",
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
      mode: Type.Optional(StringEnum(["dump", "tar"] as const, {
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
    renderCall(args, _theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const p = args as { action?: string; project_dir?: string };
      text.setText(["codegraph_setup", p.action ?? "", p.project_dir ?? ""].filter(Boolean).join("  "));
      return text;
    },
    async execute(_id, params, signal) {
      try {
        if (params.action === "bootstrap_env") {
          if (signal?.aborted) return err("codegraph_setup aborted before dispatch");
          return await deps.bootstrapEnv(params as Record<string, unknown>);
        }
        const b = await deps.ensureBridge();
        if (signal?.aborted) return err("codegraph_setup aborted before dispatch");
        const tmo = params.action === "index" || params.action === "bootstrap"
          ? SETUP_TIMEOUT_MS : 180_000;
        const res = await b.call("setup", params as Record<string, unknown>, tmo);
        if (!res.ok) return err(`codegraph setup error: ${res.error}`, { error: res.error });
        const r = res.result;
        const text = typeof r === "string" ? r : JSON.stringify(r, null, 2);
        return ok(text, { action: params.action, raw: r });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`codegraph_setup failed: ${msg}`, { error: msg });
      }
    },
  });
}
