# codegraph

A [Pi](https://github.com/nicobailon/pi) extension that bundles the
[**codegraph**](../codegraph) and [**doxygen-index**](../doxygen-dependency-parser)
libraries into one portable package. It can **bootstrap its own Python
environment**, **generate a project's indexing config**, **index source code
into the graph**, and then **retrieve rich knowledge-graph context** for an AI
coding agent — plus an interactive HTML visualizer for the neighborhood of any
code object.

The graph backend is **SQLite by default** (a plain file — no Docker, no
service to run). **Neo4j/Docker is a deprecated legacy backend**, available
only when explicitly selected via `backend='neo4j'` or
`CODEGRAPH_BACKEND=neo4j`.

The design goal is a **narrow tool surface**: instead of exposing every
library operation as its own tool, richly-parameterised entry points
steer all retrieval *and* setup. A long-lived Python sidecar holds a single
`CodeGraphDispatcher` (with its cached `LayerGraph`) for the whole session,
so repeated fetches, format re-exports, and renders avoid re-initialising
the backend.

The proposed design for treating a Codex workspace as one logical project
containing multiple repository sources in a shared SQLite database was
implemented — see [Multi-Repository Project Database](docs/plans/multi-repository-project-database.md)
for the plan and [Multi-repository projects](#multi-repository-projects) below
for how to use it.

## Tools

The extension exposes **nine** tools. `codegraph_query`, `codegraph_explore`,
`codegraph_tests`, `codegraph_stats`, `codegraph_discover`, and
`codegraph_memory` are read-only retrieval; `codegraph_decompose` and
`codegraph_design` run the agent pipelines; `codegraph_setup` bootstraps and
operates the graph.

### `codegraph_setup` — bootstrap & operate

One `action` discriminator drives the full setup pipeline. On a fresh machine,
start with `bootstrap_env`; to graph a new project end-to-end, use `bootstrap`.

| action | requires | does |
|---|---|---|
| `bootstrap_env` | — | create/refresh a venv with `codegraph` + `doxygen-index` installed, then restart the bridge under it. Run once per machine. Sources overridable via `codegraph_source` / `doxygen_index_source` (pass a path for an editable install). |
| `init_config` | `project_dir` or `repository` | auto-detect language (C++/Python), `input_paths`, `test_paths`, and project name (from `pyproject.toml` or dir name) and write `.doxygen-index.toml`. Override any field; `force` to overwrite. |
| `index` | `project_dir` or `repository` | run `doxygen-index` to parse a repository and ingest into the shared SQLite database (`format: sqlite`, default), write JSON (`format: json`), or explicitly use the deprecated legacy Neo4j backend (`format: neo4j`). With an active project manifest, pass `repository='<name>'` to resolve the directory + stable source label; `clear=true` replaces **only that source**. |
| `index_all` | active project manifest | index **every** enabled manifest repository into the shared database, sequentially, replacing only each repository's own source when `clear=true`. Returns a per-repository summary (duration, exit status, post-index node count); a failure of one repo preserves the others. |
| `db_start` / `db_stop` / `db_restart` / `db_status` | `project_dir` | **Neo4j backend only** — manage the project-local Neo4j Docker container (`neo4j-<project>`, data bind-mounted at `codegraph/neo4j/`) via the `codegraph-db` CLI. |
| `bootstrap` | `project_dir` or `repository` | one-shot pipeline: `init_config` → `index` (`db_start` only when `backend='neo4j'`). |
| `migrate_database` | `legacy_path` | copy an existing database into the project location with SQLite's backup API (WAL-safe). Refuses to overwrite a populated destination unless `force=true`; always preserves the original and backs up a pre-existing destination as `.pre-migrate`; validates node/edge counts at the destination. |
| `status` | `project_dir?` | health overview: active project (id, manifest, directory, discovery source), the exact database opened by the backend (path, existence, size, node/relationship counts), per-repository indexed state (enabled/exists/indexed/node count), bridge ping, codegraph version, backend reachability, available tags + node counts. |

Typical first-run workflow:

1. `codegraph_setup` → `bootstrap_env` (provision the venv)
2. `codegraph_setup` → `bootstrap` with `project_dir` (config + index — SQLite by default, no Docker)
3. `codegraph_explore` → `search` to find symbols
4. `codegraph_query` → `neighborhood` to fetch full context
5. `codegraph_query` → `html` to *see* the graph

### `codegraph_query`

Fetch a scoped subgraph and return it formatted for analysis. One `scope`
discriminator steers every retrieval mode:

| scope | requires | retrieves |
|---|---|---|
| `tag` | `tag` | an entire design view (`design` / `as-built` / `dependency`) + 1-hop neighbors |
| `namespace` | `qualified_name` | a namespace + everything it composes + neighbors |
| `compound` | `qualified_name` | a single class / interface / enum + neighbors |
| `neighborhood` | `qualified_name` | any node + its 1-hop relationships (deep-inspection mode) |
| `source` | `source` | a whole indexed source project + neighbors |
| `kind` | `kind` (`tag` optional) | all nodes of a kind (e.g. all classes) + neighbors |
| `cached` | — | re-export the **last fetched** graph in a different format — no Neo4j re-query |

`format` selects the output:

- **`markdown`** (default) — human-readable public API + relationships
- **`plantuml`** — class diagram
- **`json`** — raw serialized `LayerGraph`
- **`html`** — interactive [Cytoscape.js](https://js.cytoscape.org/) visualisation
  of the neighborhood, written to a file and opened in the browser
  (`size`: `large`/`small`, `open`: `false` to skip auto-open, `output`: custom path)

The fetched graph is cached server-side, so follow an expensive fetch with
`scope: "cached"` to switch formats for free.

### `codegraph_explore`

Lightweight lookups returning slim JSON (not a full serialized graph) — used
to *find* symbols before fetching full context. One `action` discriminator:

| action | requires | returns |
|---|---|---|
| `search` | `query` (`source`/`kind`/`limit` optional) | compounds matching a qualified-name substring |
| `compound` | `qualified_name` | a class + its member list |
| `member` | `qualified_name` | a single method / attribute |
| `namespace` | `namespace` (`limit` optional) | compounds under a namespace prefix |
| `sources` | — | indexed source projects + node counts |
| `tags` | — | available provenance tags + node counts |
| `inheritance` | `qualified_name` | parents + children of a compound |
| `callers_callees` | `qualified_name` | what calls / is called by a member |

Typical workflow: `explore` → `search` to find a symbol → `query` →
`neighborhood` to fetch its full formatted context → `query` → `cached` +
`json`/`plantuml` to re-view it another way → `query` → `html` to *see* it.

### `codegraph_tests`

Test-focused exploration returning slim JSON. Tests (from `test_paths`) are
indexed as `test` / `test_step` / `test_fixture` / `assertion` nodes linked to
the code under test by `VERIFIES` (test → method/class) and `CALLEE` (test_step
→ called code). One `action` discriminator:

| action | requires | returns |
|---|---|---|
| `list` | `source`/`test_module`/`tag`/`limit` optional | all tests + the code each verifies |
| `modules` | filters optional | tests grouped by test module |
| `verifies` | `qualified_name` (a test) | the code nodes a test exercises |
| `covered_by` | `qualified_name` (a code node) | tests that verify it — **including tests of a class's members** (a coverage view) |
| `detail` | `qualified_name` (a test) | the test's verifies targets + steps (with callees) + fixtures + assertions |

For a *visual* graph of a test's neighborhood, use `codegraph_query` with
`scope: neighborhood` and the test's `qualified_name`. `covered_by` is the
headline query — "which tests cover this class/method?" — and its member
expansion surfaces tests of every method on a class.

## Multi-repository projects

A Codex workspace can contain several repositories that should be indexed into
**one** knowledge graph (plus workspace roots that must not be indexed, such as
a shared `.venv`). A project is declared by `.codegraph-project.toml` in a
designated anchor directory — the manifest owns the database selection and
lists the repositories that contribute sources to it:

```toml
schema_version = 1

[project]
id = "codegraph-suite"
database = ".codegraph/codegraph.sqlite3"

[[repositories]]
name = "codegraph"
path = ".."
source = "codegraph"

[[repositories]]
name = "codegraph-mcp"
path = "../codegraph-mcp"
source = "codegraph-mcp"

[[repositories]]
name = "cpp-sqlite"
path = "../cpp-sqlite"
source = "cpp-sqlite"

[[repositories]]
name = "python-environment"
path = "../.venv"
index = false   # never an index target
```

Rules: `schema_version` must be `1`; `project.id` is required and
filesystem-safe; `project.database` is resolved against the manifest directory
(relative or absolute); repository `name`s must be unique, enabled `source`s
must be unique (defaults to `name`), two entries cannot resolve to the same
canonical path, and `index` defaults to `true`. A missing repository path
produces a diagnostic but never blocks read-only access to the database. The
project database must never resolve inside the installed plugin bundle.

### Project discovery

Resolution precedence, applied **before the Python bridge starts**:

1. `CODEGRAPH_PROJECT_FILE`, when explicitly set.
2. One manifest discovered from the client's workspace roots (MCP
   `roots/list`; a Pi session uses its working directory).
3. An explicitly configured **absolute** `SQLITE_PATH` (backward
   compatibility).
4. A central fallback: `<PLUGIN_DATA>/projects/<stable-hash-of-roots>/` —
   storage isolation keyed on the canonical root set (order-independent), so
   every fresh task for the same workspace selects the same database even
   before a manifest exists.

Multiple root manifests produce an actionable ambiguity error before any
bridge starts. Root-change notifications (`notifications/roots/list_changed`)
stop the running bridge, re-resolve the project, and start a fresh bridge on
the next tool call.

All indexing subprocesses for the project receive the same absolute
`SQLITE_PATH`. The selected repository determines only the subprocess working
directory, its `.doxygen-index.toml`, the default source label, and
source-scoped replacement — `clear=true` clears **one source**, never the
shared database. Every repository keeps its own `.doxygen-index.toml` because
language, inputs, test paths, and parser settings may differ.

### Indexing repositories

With an active manifest, select a repository by name instead of a raw path:

```json
{ "action": "index", "repository": "codegraph-mcp", "clear": true }
```

Conflicting `repository` + `project_dir` / `source` forms are rejected rather
than silently resolved. Without `repository` or `project_dir`, `index` selects
the sole enabled repository (or returns a selection error). To index everything:

```json
{ "action": "index_all", "clear": true }
```

`index_all` runs repositories sequentially (no concurrent SQLite writers),
replaces only each repository's own source when `clear=true`, and returns a
per-repository summary with duration, exit status, and post-index node counts.
A failure of one repository preserves the ones that succeeded.

`codegraph_setup action='status'` shows the active project (id, manifest,
directory, discovery source), the exact database the backend opened (path,
existence, size, node/relationship counts), and per-repository indexed state.

## Slash command

`/codegraph status` — ping the bridge, report codegraph version + python interpreter
`/codegraph restart` — restart the Python sidecar
`/codegraph bootstrap [codegraph-src] [doxygen-index-src]` — provision the venv (action='bootstrap_env')
`/codegraph venv` — show the venv path + whether it exists
`/codegraph python [path|--clear]` — with a path, **persist** the interpreter to `~/.pi/agent/codegraph/config.json` (one-time setup; no `export` needed afterwards). With `--clear`, remove it. No arg: show the resolved interpreter and where it came from.
`/codegraph bridge` — print the resolved bridge script path

## Install

### Prerequisites

- **Docker** — only needed if you opt into the **Neo4j backend**
  (`backend='neo4j'`, `CODEGRAPH_BACKEND=neo4j`, or the `db_*` actions).
  The default SQLite backend is a plain file — nothing to install or run.
  If you already run Neo4j elsewhere, set `NEO4J_URI` / `NEO4J_USER` /
  `NEO4J_PASSWORD` and skip the Docker actions.
- `doxygen` on PATH — only needed for **C++** projects (`index` action).
- A **Python 3.10+** interpreter — only needed to create the bootstrapped
  venv (`bootstrap_env`). The extension otherwise runs entirely inside that
  venv, so you do **not** need codegraph/doxygen-index pre-installed.

### Two ways to get the Python environment

**A. Auto-provision (portable, recommended).** The extension creates its own
venv and installs both libraries:

```bash
pi install ./codegraph
# then inside Pi:
#   call codegraph_setup with action='bootstrap_env'
# or from the shell:
#   /codegraph bootstrap
```

By default it `pip install`s `codegraph` and `doxygen-index` from PyPI. To
install from your local working copies instead (editable), point at the paths:

```bash
export CODEGRAPH_SOURCE=/Users/danielnewman/dev/codegraph
export DOXYGEN_INDEX_SOURCE=/Users/danielnewman/dev/doxygen-dependency-parser
# or pass them as codegraph_source / doxygen_index_source params to bootstrap_env
```

**B. Use an existing venv.** If you already have a venv with both packages
installed (e.g. the shared `~/dev/.venv`), skip `bootstrap_env` and point the
bridge at it. You only need to do this **once** — it's persisted:

```bash
pi                       # start Pi in any folder
# then run the slash command once:
#   /codegraph python /Users/danielnewman/dev/.venv/bin/python
# and restart so the bridge relaunches under it:
#   /codegraph restart
```

This writes `~/.pi/agent/codegraph/config.json` and is read on every launch
afterwards — no `export` needed. (You can also `export CODEGRAPH_PYTHON=...`
per shell, or pass `--codegraph-python <path>` per launch; the persisted config
sits between the env var and the bootstrapped venv in precedence.)

### Backend configuration

The sidecar **auto-loads a `.env` from the working directory (or nearest
parent)** for `CODEGRAPH_BACKEND` / `SQLITE_PATH` / `NEO4J_URI` /
`NEO4J_USER` / `NEO4J_PASSWORD`, so a folder that already has one needs no
extra setup. Real environment variables take precedence for most keys;
`NEO4J_*` in `.env` are authoritative (they override an inherited
environment, mirroring the `LLM_*` handling).

The backend is selected via `CODEGRAPH_BACKEND`:

- `sqlite` (default) — a plain SQLite file at `SQLITE_PATH` (default
  `codegraph.sqlite3` relative to the project dir). No service to manage.
- `neo4j` — the project-local Neo4j Docker container, with `NEO4J_URI`
  (default `bolt://localhost:7687`), `NEO4J_USER` (default `neo4j`),
  `NEO4J_PASSWORD`.

### Load into Pi

```bash
pi install ./codegraph        # from this repo's parent dir
# or load ad-hoc without installing:
pi -e ./codegraph/index.ts
```

## Configuration

| flag | env | default | purpose |
|---|---|---|---|
| `--codegraph-python` | `CODEGRAPH_PYTHON` | persisted config, else bootstrapped venv python, else `python3` | interpreter for the bridge |
| `--codegraph-bridge` | — | `<ext>/bridge/codegraph_bridge.py` | path to the sidecar script |
| `--codegraph-venv` | — | `~/.pi/agent/codegraph/venv` | auto-provisioned venv path |

**Python resolution precedence:** `--codegraph-python` flag > `$CODEGRAPH_PYTHON`
env > `/codegraph python <path>` persisted config (`~/.pi/agent/codegraph/config.json`)
> bootstrapped venv (`--codegraph-venv`) > `python3`.
| `--codegraph-python-base` | `CODEGRAPH_PYTHON_BASE` | `python3` | base interpreter for `bootstrap_env` |
| `--codegraph-source` | `CODEGRAPH_SOURCE` | `codegraph` | pip spec / path for codegraph |
| `--doxygen-index-source` | `DOXYGEN_INDEX_SOURCE` | `doxygen-index` | pip spec / path for doxygen-index |
| `--codegraph-steer-reads` | — | `false` | opt-in: block the first source-code `read` of each distinct path until a `codegraph_*` tool is used (enforcement layer; see Steering below) |

## Steering the agent toward the graph tools

The tools are only useful if the agent actually reaches for them. There are
**two complementary layers**, from gentle to forceful:

### 1. Guidance — `AGENTS.md` (recommended, always-on)

Pi auto-discovers `AGENTS.md` (and `CLAUDE.md`) from the working directory and
parents and folds it into the system prompt. Drop this in the repo root of any
**indexed** project so the agent prefers the graph tools for structural /
relational questions:

```markdown
# AGENTS.md

## Codebase exploration

This repository is indexed in a codegraph knowledge graph. The
`codegraph_query`, `codegraph_explore`, and `codegraph_tests` tools retrieve structured graph
context (classes, members, call graphs, inheritance, namespaces, tests) that is far
richer than grepping source.

- For **structure / relationships / call graphs / inheritance / "who calls X"**:
  call `codegraph_explore` (action: search / compound / member / callers_callees
  / inheritance) and `codegraph_query` (scope: neighborhood, format: markdown)
  *before* reading source files.
- For **tests / coverage / "which tests cover this code?"**: call `codegraph_tests`
  (action: covered_by for a class/method, verifies/detail for a test, list/modules
  to browse). Use it before grepping `tests/`.
- Use `read`/`grep` for **exact file contents / text-level detail** after you
  have the graph context, not as the first move for understanding architecture.
- `codegraph_query` with `format: html` renders an interactive neighborhood
  graph — handy when a visual is clearer than prose.
- The `as-built` provenance tag holds the indexed source; `dependency` /
  `design` / `scaffold` may be empty.
```

This is the light-touch default: it nudges every turn without breaking reads.

### 2. Enforcement — `--codegraph-steer-reads` (opt-in, hard)

For agents that ignore prose guidance, the extension can **block** the first
source-code `read` of each distinct path until a `codegraph_*` tool has been
called, returning a steering reason the model must respond to:

```bash
pi --codegraph-steer-reads true     # extension boolean flags take a value
```

Safeguards (verified): a given file path is blocked **at most once** per
session, steering stops entirely once any `codegraph_*` tool is used, and a
hard cap of 8 blocks per session bounds it — so it can never infinite-loop. Only
reads of source-like paths (code extensions or `src/`/`lib/`/`app/`/… segments)
are affected; reads of `README.md`, `package.json`, configs, etc. always pass.

This is the "pre-execution hook on file reads" pattern: Pi's `tool_call` event
fires *before* execution and can return `{block: true, reason}` (and mutate
`event.input`), so the extension intercepts the read and redirects the agent.
Use it when you want guaranteed steering; leave it off and rely on `AGENTS.md`
otherwise.
| — | `CODEGRAPH_BACKEND` / `SQLITE_PATH` | `sqlite` / `codegraph.sqlite3` | backend selection (SQLite default; `neo4j` opts into Docker) |
| — | `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD` | localhost defaults | Neo4j backend connection (opt-in) |

## Architecture

```
Pi session  ──►  index.ts (TS extension)
                  │  registers 9 tools (query / explore / tests / stats / setup / discover / decompose / design / memory) + /codegraph + flags
                  │  bootstrap_env (TS-side): creates venv, pip-installs codegraph + doxygen-index
                  │  spawns & keeps alive:
                  ▼
                  bridge/codegraph_bridge.py  (stdio JSON-RPC daemon, runs in the venv)
                  │  query/explore → CodeGraphDispatcher (cached current_graph) → active backend
                  │  setup → subprocesses: `doxygen-index` CLI (parse+ingest)
                  │                          `codegraph-db` CLI  (Neo4j backend lifecycle)
                  ▼
        ┌─────────────────────┐
        │  SQLite (default)   │  ◄── codegraph portable Backend API  ◄── doxygen-index parser
        │  Neo4j (opt-in)     │
        └─────────────────────┘
```

The bridge speaks newline-delimited JSON over stdin/stdout
(`{"id","method","params"}` → `{"id","ok","result"|"error"}`). Only JSON is
written to stdout; all Python/neomodel diagnostics go to stderr so the
framing channel stays clean. Setup actions that would otherwise `print` /
`sys.exit` (the `doxygen-index` and `codegraph-db` CLIs) are driven as
`python -m <module>` **subprocesses** with captured stdout/stderr, so they
can never corrupt the framing channel. The sidecar is lazily started on the
first tool call and restarted on each `session_start`; it's torn down on
`session_shutdown` (and after `bootstrap_env` so it re-launches under the new
venv python).

## Bundled / portable packaging

The npm package ships `index.ts` + `bridge/`. It does **not** vendor Python
or wheels — instead `codegraph_setup action='bootstrap_env'` provisions a
self-contained venv at `~/.pi/agent/codegraph/venv` (overridable) and
installs `codegraph` + `doxygen-index` from PyPI or local paths. The bridge
then runs inside that venv, so the extension is portable to any machine with
Python 3.10+ (Docker only if you opt into the Neo4j backend).

## Develop

```bash
# type-check
npx tsc --noEmit -p tsconfig.json
# bridge syntax check
python3 -c "import ast; ast.parse(open('bridge/codegraph_bridge.py').read())"
# runtime round-trip (needs NEO4J_PASSWORD + CODEGRAPH_PYTHON pointing at the venv)
npx tsx stub.test.ts
```

## License

MIT
