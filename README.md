# codegraph-mcp

A [Pi](https://github.com/nicobailon/pi) extension that bundles the
[**codegraph**](../codegraph) and [**doxygen-index**](../doxygen-dependency-parser)
libraries into one portable package. It can **bootstrap its own Python
environment**, **generate a project's indexing config**, **manage a
project-local Neo4j Docker container**, **index source code into the graph**,
and then **retrieve rich knowledge-graph context** for an AI coding agent —
plus an interactive HTML visualizer for the neighborhood of any code object.

The design goal is a **narrow tool surface**: instead of exposing every
library operation as its own tool, three richly-parameterised entry points
steer all retrieval *and* setup. A long-lived Python sidecar holds a single
`CodeGraphDispatcher` (with its cached `LayerGraph`) for the whole session,
so repeated fetches, format re-exports, and renders avoid re-initialising
Neo4j.

## Tools

The extension exposes **three** tools. `codegraph_query` and `codegraph_explore`
are read-only retrieval; `codegraph_setup` bootstraps and operates the graph.

### `codegraph_setup` — bootstrap & operate

One `action` discriminator drives the full setup pipeline. On a fresh machine,
start with `bootstrap_env`; to graph a new project end-to-end, use `bootstrap`.

| action | requires | does |
|---|---|---|
| `bootstrap_env` | — | create/refresh a venv with `codegraph` + `doxygen-index` installed, then restart the bridge under it. Run once per machine. Sources overridable via `codegraph_source` / `doxygen_index_source` (pass a path for an editable install). |
| `init_config` | `project_dir` | auto-detect language (C++/Python), `input_paths`, `test_paths`, and project name (from `pyproject.toml` or dir name) and write `.doxygen-index.toml`. Override any field; `force` to overwrite. |
| `index` | `project_dir` | run `doxygen-index` to parse the project and ingest into Neo4j (`format: neo4j`, default) or write JSON (`format: json`, also emits HTML when `[codegraph-html]` is configured). |
| `db_start` / `db_stop` / `db_restart` / `db_status` | `project_dir` | manage the project-local Neo4j Docker container (`neo4j-<project>`, data bind-mounted at `codegraph/neo4j/`) via the `codegraph-db` CLI. |
| `bootstrap` | `project_dir` | one-shot pipeline: `init_config` → `db_start` → `index`. |
| `status` | `project_dir?` | health overview: bridge ping, codegraph version, Neo4j reachability, Docker container state, available tags + node counts. |

Typical first-run workflow:

1. `codegraph_setup` → `bootstrap_env` (provision the venv)
2. `codegraph_setup` → `bootstrap` with `project_dir` (config + Neo4j + index)
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

## Slash command

`/codegraph status` — ping the bridge, report codegraph version + python interpreter
`/codegraph restart` — restart the Python sidecar
`/codegraph bootstrap [codegraph-src] [doxygen-index-src]` — provision the venv (action='bootstrap_env')
`/codegraph venv` — show the venv path + whether it exists
`/codegraph python [path|--clear]` — with a path, **persist** the interpreter to `~/.pi/agent/codegraph-mcp/config.json` (one-time setup; no `export` needed afterwards). With `--clear`, remove it. No arg: show the resolved interpreter and where it came from.
`/codegraph bridge` — print the resolved bridge script path

## Install

### Prerequisites

- **Docker** — only needed for the project-local Neo4j container
  (`codegraph_setup` actions `db_*` / `bootstrap`). If you already run a
  Neo4j elsewhere, set `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD` and
  skip the Docker actions.
- `doxygen` on PATH — only needed for **C++** projects (`index` action).
- A **Python 3.10+** interpreter — only needed to create the bootstrapped
  venv (`bootstrap_env`). The extension otherwise runs entirely inside that
  venv, so you do **not** need codegraph/doxygen-index pre-installed.

### Two ways to get the Python environment

**A. Auto-provision (portable, recommended).** The extension creates its own
venv and installs both libraries:

```bash
pi install ./codegraph-mcp
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

This writes `~/.pi/agent/codegraph-mcp/config.json` and is read on every launch
afterwards — no `export` needed. (You can also `export CODEGRAPH_PYTHON=...`
per shell, or pass `--codegraph-python <path>` per launch; the persisted config
sits between the env var and the bootstrapped venv in precedence.)

### Neo4j connection

The sidecar **auto-loads a `.env` from the working directory (or nearest
parent)** for `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD`, so a folder that
already has one (e.g. after `codegraph-db start`, which writes it) needs no
extra setup. Real environment variables always take precedence. Otherwise set
`NEO4J_URI` (default `bolt://localhost:7687`), `NEO4J_USER` (default `neo4j`),
`NEO4J_PASSWORD`.

### Load into Pi

```bash
pi install ./codegraph-mcp        # from this repo's parent dir
# or load ad-hoc without installing:
pi -e ./codegraph-mcp/index.ts
```

## Configuration

| flag | env | default | purpose |
|---|---|---|---|
| `--codegraph-python` | `CODEGRAPH_PYTHON` | persisted config, else bootstrapped venv python, else `python3` | interpreter for the bridge |
| `--codegraph-bridge` | — | `<ext>/bridge/codegraph_bridge.py` | path to the sidecar script |
| `--codegraph-venv` | — | `~/.pi/agent/codegraph-mcp/venv` | auto-provisioned venv path |

**Python resolution precedence:** `--codegraph-python` flag > `$CODEGRAPH_PYTHON`
env > `/codegraph python <path>` persisted config (`~/.pi/agent/codegraph-mcp/config.json`)
> bootstrapped venv (`--codegraph-venv`) > `python3`.
| `--codegraph-python-base` | `CODEGRAPH_PYTHON_BASE` | `python3` | base interpreter for `bootstrap_env` |
| `--codegraph-source` | `CODEGRAPH_SOURCE` | `codegraph` | pip spec / path for codegraph |
| `--doxygen-index-source` | `DOXYGEN_INDEX_SOURCE` | `doxygen-index` | pip spec / path for doxygen-index |
| — | `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD` | localhost defaults | Neo4j connection |

## Architecture

```
Pi session  ──►  index.ts (TS extension)
                  │  registers 3 tools (query / explore / setup) + /codegraph + flags
                  │  bootstrap_env (TS-side): creates venv, pip-installs codegraph + doxygen-index
                  │  spawns & keeps alive:
                  ▼
                  bridge/codegraph_bridge.py  (stdio JSON-RPC daemon, runs in the venv)
                  │  query/explore → CodeGraphDispatcher (cached current_graph) → Neo4j
                  │  setup → subprocesses: `doxygen-index` CLI (parse+ingest)
                  │                          `codegraph-db` CLI  (Neo4j Docker lifecycle)
                  ▼
                  Neo4j  ◄── codegraph neomodel models  ◄── doxygen-index parser
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
self-contained venv at `~/.pi/agent/codegraph-mcp/venv` (overridable) and
installs `codegraph` + `doxygen-index` from PyPI or local paths. The bridge
then runs inside that venv, so the extension is portable to any machine with
Python 3.10+ (and Docker for the Neo4j container).

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