/**
 * Multi-repository project database — host-neutral manifest parsing and
 * project resolution.
 *
 * A project is declared by ``.codegraph-project.toml`` in a designated
 * anchor directory.  The manifest owns the database selection and lists the
 * repositories that contribute sources to it.
 *
 * Resolution precedence (see docs/plans/multi-repository-project-database.md):
 *
 *   1. ``CODEGRAPH_PROJECT_FILE``, when explicitly set.
 *   2. One manifest discovered from MCP workspace roots.
 *   3. An explicitly configured absolute ``SQLITE_PATH``, for compatibility.
 *   4. A safe central fallback keyed by the canonical workspace-root set.
 *
 * This module must not import Pi or MCP packages.  Project selection
 * happens before the Python bridge starts, so parsing lives in the
 * host-neutral TypeScript layer.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { parse as parseToml } from "smol-toml";

// ── Types ─────────────────────────────────────────────────────────────────

/** A workspace root as reported by the host (e.g. MCP `roots/list`). */
export interface WorkspaceRoot {
  uri: string;
  name?: string;
}

export interface ProjectRepository {
  name: string;
  source: string;
  /** Absolute, canonicalized path. */
  path: string;
  index: boolean;
  exists: boolean;
}

export type DiscoverySource =
  | "explicit"
  | "mcp-roots"
  | "absolute-sqlite"
  | "fallback";

export interface ProjectContext {
  id: string;
  /** Absolute path to the manifest, when one selected the project. */
  manifestPath?: string;
  /** Absolute canonical directory used as the bridge cwd / anchor. */
  projectDir: string;
  /** Absolute database path. */
  databasePath: string;
  repositories: ProjectRepository[];
  discoverySource: DiscoverySource;
}

/** A manifest as written on disk (before path resolution). */
export interface ProjectManifest {
  schemaVersion: number;
  id: string;
  database: string;
  repositories: ManifestRepositoryEntry[];
  /** Absolute canonical directory containing the manifest. */
  manifestDir: string;
}

export interface ManifestRepositoryEntry {
  name: string;
  source: string;
  path: string;
  index: boolean;
}

// ── Errors ────────────────────────────────────────────────────────────────

export class ProjectError extends Error {}

// ── Fallback key ──────────────────────────────────────────────────────────

/**
 * Stable, order-independent hash of the canonical workspace-root set.
 * Used as the fallback project identity so every fresh task for the same
 * workspace selects the same database regardless of root ordering.
 */
export function workspaceFallbackKey(rootPaths: string[]): string {
  const sorted = [...rootPaths].sort();
  return createHash("sha256").update(sorted.join("\n")).digest("hex").slice(0, 16);
}

/** Path suffix validation for project ids (filesystem-safe, stable). */
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// ── Manifest parsing & validation ─────────────────────────────────────────

/** Canonicalize a path; tolerates not-yet-existing files/dirs by
 *  canonicalizing the nearest existing ancestor. */
function canonicalize(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    let dir = dirname(p);
    let base = basename(p);
    try {
      dir = realpathSync(dir);
    } catch {
      return resolve(p);
    }
    return join(dir, base);
  }
}

/** Convert a `file://` URI to a filesystem path (plain paths pass through). */
export function rootPathFromUri(uri: string): string {
  if (uri.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(uri).pathname);
    } catch {
      return uri;
    }
  }
  return uri;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parse and validate a manifest.  Throws `ProjectError` with a
 * human-readable message for every violation.
 */
export function parseProjectManifest(
  text: string,
  manifestPath: string,
): ProjectManifest {
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (e) {
    throw new ProjectError(
      `Invalid TOML in ${manifestPath}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!isRecord(raw)) {
    throw new ProjectError(`Manifest ${manifestPath} must be a TOML table`);
  }

  const schemaVersion = raw["schema_version"];
  if (typeof schemaVersion !== "number" || schemaVersion !== 1) {
    throw new ProjectError(
      `Manifest ${manifestPath}: unsupported schema_version ${JSON.stringify(schemaVersion)} (expected 1)`,
    );
  }

  const proj = raw["project"];
  if (!isRecord(proj)) {
    throw new ProjectError(`Manifest ${manifestPath}: missing [project] table`);
  }
  const id = proj["id"];
  if (typeof id !== "string" || !id.trim()) {
    throw new ProjectError(`Manifest ${manifestPath}: project.id is required`);
  }
  if (!PROJECT_ID_RE.test(id)) {
    throw new ProjectError(
      `Manifest ${manifestPath}: project.id ${JSON.stringify(id)} is not filesystem-safe ` +
      `(use letters, digits, '.', '_', '-'; must not start with '.')`,
    );
  }
  const database = proj["database"];
  if (typeof database !== "string" || !database.trim()) {
    throw new ProjectError(`Manifest ${manifestPath}: project.database is required`);
  }

  const rawRepos = raw["repositories"];
  if (rawRepos !== undefined && !Array.isArray(rawRepos)) {
    throw new ProjectError(`Manifest ${manifestPath}: repositories must be an array`);
  }
  const repos: ManifestRepositoryEntry[] = [];
  const names = new Set<string>();
  const sources = new Set<string>();
  const canonicalPaths = new Map<string, string>(); // canon path -> first repo name
  for (const [i, entry] of (rawRepos as unknown[] | undefined ?? []).entries()) {
    if (!isRecord(entry)) {
      throw new ProjectError(`Manifest ${manifestPath}: repositories[${i}] must be a table`);
    }
    const name = entry["name"];
    if (typeof name !== "string" || !name.trim()) {
      throw new ProjectError(`Manifest ${manifestPath}: repositories[${i}] name is required`);
    }
    if (names.has(name)) {
      throw new ProjectError(`Manifest ${manifestPath}: duplicate repository name '${name}'`);
    }
    names.add(name);

    const path = entry["path"];
    if (typeof path !== "string" || !path.trim()) {
      throw new ProjectError(`Manifest ${manifestPath}: repository '${name}' path is required`);
    }

    let source: string | undefined = entry["source"] as string | undefined;
    if (source !== undefined && (typeof source !== "string" || !source.trim())) {
      throw new ProjectError(`Manifest ${manifestPath}: repository '${name}' source must be a string`);
    }
    source = source || name;

    const indexRaw = entry["index"];
    const index = indexRaw === undefined ? true : indexRaw;
    if (typeof index !== "boolean") {
      throw new ProjectError(`Manifest ${manifestPath}: repository '${name}' index must be a boolean`);
    }
    if (index) {
      if (sources.has(source)) {
        throw new ProjectError(
          `Manifest ${manifestPath}: duplicate enabled source '${source}' (repository '${name}')`,
        );
      }
      sources.add(source);
    }

    repos.push({ name, source, path, index });
  }

  const manifestDir = canonicalize(dirname(manifestPath));
  for (const r of repos) {
    const abs = isAbsolute(r.path) ? r.path : resolve(manifestDir, r.path);
    const canon = canonicalize(abs);
    const owner = canonicalPaths.get(canon);
    if (owner !== undefined) {
      throw new ProjectError(
        `Manifest ${manifestPath}: repositories '${owner}' and '${r.name}' resolve to the same path ${canon}`,
      );
    }
    canonicalPaths.set(canon, r.name);
  }

  return {
    schemaVersion,
    id,
    database,
    repositories: repos,
    manifestDir,
  };
}

/** Load a manifest from disk. */
export function loadProjectManifest(manifestPath: string): ProjectManifest {
  const abs = resolve(manifestPath);
  if (!existsSync(abs)) {
    throw new ProjectError(`Project manifest not found: ${abs}`);
  }
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch (e) {
    throw new ProjectError(`Cannot read ${abs}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return parseProjectManifest(text, abs);
}

// ── Context construction ──────────────────────────────────────────────────

function repoExists(p: string): boolean {
  return existsSync(p);
}

/** Resolve a manifest into a ProjectContext. */
export function projectContextFromManifest(
  manifest: ProjectManifest,
  discoverySource: DiscoverySource,
): ProjectContext {
  const dbAbs = isAbsolute(manifest.database)
    ? manifest.database
    : resolve(manifest.manifestDir, manifest.database);
  const databasePath = canonicalize(dbAbs);

  const repositories: ProjectRepository[] = manifest.repositories.map((r) => {
    const abs = isAbsolute(r.path) ? r.path : resolve(manifest.manifestDir, r.path);
    const path = canonicalize(abs);
    return {
      name: r.name,
      source: r.source,
      path,
      index: r.index,
      exists: repoExists(path),
    };
  });

  return {
    id: manifest.id,
    manifestPath: join(manifest.manifestDir, ".codegraph-project.toml"),
    projectDir: manifest.manifestDir,
    databasePath,
    repositories,
    discoverySource,
  };
}

/** Build a context from a legacy absolute SQLITE_PATH (compat mode). */
export function projectContextFromSqlitePath(
  sqlitePath: string,
  cwd: string,
): ProjectContext {
  const databasePath = canonicalize(sqlitePath);
  const digest = createHash("sha256").update(databasePath).digest("hex").slice(0, 16);
  return {
    id: `legacy-${digest}`,
    projectDir: cwd,
    databasePath,
    repositories: [],
    discoverySource: "absolute-sqlite",
  };
}

/** Build the central fallback context keyed on workspace roots. */
export function projectContextFromFallback(
  rootPaths: string[],
  pluginDataDir: string,
  cwd: string,
): ProjectContext {
  // Roots arrive canonicalized, deduplicated, and sorted by the resolver so
  // identity and the anchor directory are stable under symlinks, duplicates,
  // and reordering.
  const key = workspaceFallbackKey(rootPaths);
  const projectDir = rootPaths[0] ? rootPaths[0] : canonicalize(cwd);
  const databasePath = canonicalize(join(pluginDataDir, "projects", key, "codegraph.sqlite3"));
  return {
    id: `workspace-${key}`,
    projectDir,
    databasePath,
    repositories: [],
    discoverySource: "fallback",
  };
}

/** True when `p` is inside `root` (path-separator aware). */
export function isPathInside(p: string, root: string): boolean {
  const r = root.endsWith(sep) ? root : root + sep;
  return p === root || p.startsWith(r);
}

/**
 * Startup invariant: the project database is writable project state and must
 * never resolve inside the installed plugin bundle (which is code).  Both
 * paths are canonicalized first so symlinked roots cannot be bypassed.
 */
export function assertDatabaseOutsidePlugin(
  databasePath: string,
  pluginRoot: string,
): void {
  if (!pluginRoot) return;
  const db = canonicalize(databasePath);
  const root = canonicalize(pluginRoot);
  if (isPathInside(db, root)) {
    throw new ProjectError(
      `Project database ${db} resolves inside the installed plugin bundle ` +
      `(${root}). The plugin directory is code, not writable project state — ` +
      `point the project manifest's database (or SQLITE_PATH) elsewhere.`,
    );
  }
}

// ── Discovery ─────────────────────────────────────────────────────────────

export interface ResolveProjectOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Raw workspace roots from the host (MCP roots/list, Pi session dir). */
  workspaceRoots?: WorkspaceRoot[];
  /** Writable data dir used for the central fallback. */
  pluginDataDir?: string;
  /** Plugin bundle root; the database must never live inside it. */
  pluginRoot?: string;
}

/** Find manifests declared directly inside the given root directories. */
export function discoverManifestInRoots(
  roots: WorkspaceRoot[],
): string[] {
  const found: string[] = [];
  for (const root of roots) {
    const dir = rootPathFromUri(root.uri);
    if (!dir) continue;
    const cand = join(dir, ".codegraph-project.toml");
    if (existsSync(cand)) {
      const canon = canonicalize(cand);
      if (!found.includes(canon)) found.push(canon);
    }
  }
  return found;
}

/**
 * Resolve the active project for the current session using the documented
 * precedence.  Throws `ProjectError` on invalid/ambiguous configuration;
 * the fallback never throws for missing manifests.
 */
export function resolveProjectContext(
  opts: ResolveProjectOptions = {},
): ProjectContext {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const roots = opts.workspaceRoots ?? [];
  const pluginDataDir = opts.pluginDataDir;
  const pluginRoot = opts.pluginRoot;

  // 1. Explicit project file.
  const explicitFile = env.CODEGRAPH_PROJECT_FILE?.trim();
  if (explicitFile) {
    const manifest = loadProjectManifest(explicitFile);
    const ctx = projectContextFromManifest(manifest, "explicit");
    if (pluginRoot) assertDatabaseOutsidePlugin(ctx.databasePath, pluginRoot);
    return ctx;
  }

  // 2. Manifest discovered from workspace roots.
  const discovered = discoverManifestInRoots(roots);
  if (discovered.length > 1) {
    throw new ProjectError(
      `Ambiguous project: multiple .codegraph-project.toml manifests found in workspace roots: ` +
      discovered.map((d) => `\n  - ${d}`).join("") +
      `\nSet CODEGRAPH_PROJECT_FILE to select one explicitly.`,
    );
  }
  if (discovered.length === 1) {
    const manifest = loadProjectManifest(discovered[0]);
    const ctx = projectContextFromManifest(manifest, "mcp-roots");
    if (pluginRoot) assertDatabaseOutsidePlugin(ctx.databasePath, pluginRoot);
    return ctx;
  }

  // 3. Explicit absolute SQLITE_PATH (backward compatibility).
  const sqlitePath = env.SQLITE_PATH?.trim();
  if (sqlitePath && isAbsolute(sqlitePath)) {
    const ctx = projectContextFromSqlitePath(sqlitePath, cwd);
    if (pluginRoot) assertDatabaseOutsidePlugin(ctx.databasePath, pluginRoot);
    return ctx;
  }

  // 4. Central fallback keyed on the canonical root set.  Roots are
  // canonicalized (symlink resolution), deduplicated, and sorted so identity
  // and the anchor directory are stable regardless of how the workspace is
  // spelled or ordered.
  const rootPaths = [...new Set(
    roots
      .map((r) => rootPathFromUri(r.uri))
      .filter(Boolean)
      .map((p) => canonicalize(p)),
  )].sort();
  const ctx = projectContextFromFallback(rootPaths, pluginDataDir ?? cwd, cwd);
  if (pluginRoot) assertDatabaseOutsidePlugin(ctx.databasePath, pluginRoot);
  return ctx;
}
