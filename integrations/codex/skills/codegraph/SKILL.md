---
name: codegraph
description: Use the codegraph knowledge graph for structured codebase context — explore symbols and relationships, fetch formatted graph context, check test coverage, and run setup/design pipelines when explicitly requested.
---

# Codegraph

This skill teaches when and how to use the nine `codegraph_*` tools exposed by
the codegraph MCP server / Pi extension. The tools query a knowledge graph
indexed from the repository's source code. Use the graph to answer structural
questions faster and more completely than grepping source.

The tools are: `codegraph_explore`, `codegraph_query`, `codegraph_tests`,
`codegraph_stats`, `codegraph_setup`, `codegraph_discover`,
`codegraph_decompose`, `codegraph_design`, and `codegraph_memory`.

## When to use each tool

- **Structural questions before reading source.** Call `codegraph_explore`
  first — `action: "search"` to find classes by name, `action: "compound"`
  for a class and its members, `action: "callers_callees"` or
  `action: "inheritance"` for relationships. Then read source files for
  implementation detail.
- **Complete, formatted context.** Use `codegraph_query` for whole
  neighborhoods and formatted output. Start broad with `scope: "tag"`, drill
  into one symbol with `scope: "neighborhood"` + `qualified_name`, and
  re-export without re-querying with `scope: "cached"`. Default `format` is
  `markdown`; `json`, `plantuml`, and `component_plantuml` are also useful.
- **Coverage and test relationships.** Use `codegraph_tests` —
  `action: "list"` to enumerate tests, `action: "covered_by"` to ask which
  tests cover a class or method, `action: "detail"` for one test's steps,
  fixtures, and assertions.
- **Compact overviews.** Use `codegraph_stats` instead of broad
  `codegraph_query scope: "kind"` queries — it always returns a few hundred
  bytes and never blows the context window.

## Setup and indexing are explicit, destructive actions

- **Do not index or bootstrap unless the user explicitly asks.** Running
  `codegraph_setup action: "index"` or `action: "bootstrap"` re-indexes a
  repository and can **replace existing graph data** for that source.
- `action: "db_restore"` replaces the entire database. `action: "clear"`
  (re-indexing with clear behavior) and `db_restore` are **destructive** —
  treat them as requiring explicit user intent.
- To check the environment without changing anything, use
  `codegraph_setup action: "status"` — it reports the active project, the
  exact database opened, and per-repository indexed state.
- If the graph looks empty, verify what is indexed first with
  `codegraph_explore action: "tags"` / `action: "sources"` before assuming
  indexing is needed.

## Multi-repository projects

A Codex workspace can be one logical project containing several repositories
indexed into a shared database. `.codegraph-project.toml` in a workspace root
declares the project: `project.id` + `project.database` (resolved against the
manifest dir) and a `[[repositories]]` list with `name`, `path`, optional
`source` (defaults to `name`), and optional `index` (defaults to true; e.g.
`index = false` for a shared `.venv`).

- When a manifest is active, prefer `codegraph_setup action: "index"` with
  `repository: "<name>"` over raw `project_dir` — the directory, stable
  source label, and shared database are resolved from the manifest. Never mix
  `repository` with `project_dir`/`source`.
- `codegraph_setup action: "index_all"` indexes every enabled repository into
  the shared database, sequentially, replacing only each repository's own
  source when `clear: true`. It returns a per-repository summary and preserves
  successful sources on partial failure.
- `clear: true` clears **one source**, never the whole shared database.
- Status shows which manifest repositories are already indexed and their node
  counts; source-filtered queries (`codegraph_query scope: "source"`) isolate
  one repository, while project-wide queries see all sources.

## Conventions

- The normal indexed source tag is **`as-built`**. Other tags (`design`,
  `dependency`, `requirements`, `scaffold`, `test`) may be empty — check
  `codegraph_explore action: "tags"` for what exists before relying on them.
- Prefer `format: "html"` only when a visualisation genuinely helps (e.g.
  showing a neighborhood). Report the generated file path rather than
  assuming a browser was opened — the harness may not open one.
- For design work, discover what already exists first:
  `codegraph_discover` (requirements/HLRs), then `codegraph_decompose`
  (HLR → LLRs with verification stubs), then `codegraph_design` (OO class
  design). Use `codegraph_memory` to record decisions and rationale.

## Typical flow

1. `codegraph_stats` — is the graph populated? What's indexed?
2. `codegraph_explore action: "search"` — find the symbol.
3. `codegraph_query scope: "neighborhood"` — full context for the symbol.
4. Read the source files for implementation detail.
