#!/usr/bin/env node
/**
 * Codex plugin manifest validator.
 *
 * Mirrors the rules the Codex CLI applies to `.codex-plugin/plugin.json`
 * (extracted from codex-cli 0.148) so CI can validate without the binary:
 *   - `name` is lowercase-hyphen, contains a letter/digit
 *   - `version` is strict semver and matches package.json
 *   - required: description, author, interface with displayName /
 *     shortDescription / longDescription / developerName / category /
 *     capabilities / defaultPrompt / brandColor
 *   - `author.url` and `interface.*URL` fields are absolute https URLs
 *   - `brandColor` is #RRGGBB
 *   - contract paths (`mcpServers` → .mcp.json, `skills` → skills/)
 *     resolve inside the repo
 *   - unknown top-level / interface fields are rejected
 *
 * Exits non-zero with a clear message on the first failure.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CODEX_ROOT = join(ROOT, "integrations", "codex");
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

const ALLOWED_TOP = new Set([
  "name", "version", "description", "author", "homepage", "repository",
  "license", "keywords", "skills", "mcpServers", "apps", "interface",
]);
const ALLOWED_AUTHOR = new Set(["name", "email", "url"]);
const ALLOWED_INTERFACE = new Set([
  "displayName", "shortDescription", "longDescription", "developerName",
  "category", "capabilities", "websiteURL", "privacyPolicyURL",
  "termsOfServiceURL", "defaultPrompt", "brandColor", "composerIcon",
  "logo", "screenshots",
]);
const REQUIRED_INTERFACE = [
  "displayName", "shortDescription", "longDescription", "developerName",
  "category", "capabilities", "defaultPrompt", "brandColor",
];

const errors = [];
const warn = [];

function requireString(obj, key, label) {
  const v = obj[key];
  if (typeof v !== "string" || v.trim() === "") {
    errors.push(`plugin.json field \`${label}.${key}\` must be a non-empty string`);
  }
  return v;
}

function httpsUrl(obj, key, label) {
  const v = obj[key];
  if (v !== undefined) {
    if (typeof v !== "string" || !v.startsWith("https://")) {
      errors.push(`plugin.json field \`${label}.${key}\` must be an absolute \`https://\` URL`);
    }
  }
}

function checkUnknownKeys(obj, allowed, label) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      errors.push(`plugin.json field \`${label}.${key}\` is not accepted by plugin validation`);
    }
  }
}

function checkContractPath(rel) {
  const abs = resolve(CODEX_ROOT, rel);
  if (!existsSync(abs)) {
    errors.push(`contract path \`${rel}\` must resolve inside the repository (${abs} missing)`);
  }
}

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(CODEX_ROOT, ".codex-plugin", "plugin.json"), "utf8"));

checkUnknownKeys(manifest, ALLOWED_TOP, "");

if (typeof manifest.name !== "string" || !NAME_RE.test(manifest.name)) {
  errors.push("plugin.json field `name` must be lowercase-hyphen with at least one letter/digit");
}
if (typeof manifest.version !== "string" || !SEMVER_RE.test(manifest.version)) {
  errors.push("plugin.json field `version` must be strict semver");
} else if (manifest.version !== pkg.version) {
  errors.push(`plugin.json version ${manifest.version} must match package.json version ${pkg.version}`);
}
requireString(manifest, "description", "");

if (typeof manifest.author !== "object" || manifest.author === null) {
  errors.push("plugin.json field `author` must be an object");
} else {
  checkUnknownKeys(manifest.author, ALLOWED_AUTHOR, "author");
  requireString(manifest.author, "name", "author");
  httpsUrl(manifest.author, "url", "author");
}

if (typeof manifest.interface !== "object" || manifest.interface === null) {
  errors.push("plugin.json field `interface` must be an object");
} else {
  checkUnknownKeys(manifest.interface, ALLOWED_INTERFACE, "interface");
  for (const field of REQUIRED_INTERFACE) {
    if (manifest.interface[field] === undefined) {
      errors.push(`plugin.json field \`interface.${field}\` is required`);
    }
  }
  for (const field of ["displayName", "shortDescription", "longDescription", "developerName", "category", "brandColor"]) {
    requireString(manifest.interface, field, "interface");
  }
  if (manifest.interface.brandColor && !HEX_RE.test(manifest.interface.brandColor)) {
    errors.push("plugin.json field `interface.brandColor` must use `#RRGGBB`");
  }
  if (!Array.isArray(manifest.interface.capabilities)
      || !manifest.interface.capabilities.every((c) => typeof c === "string")) {
    errors.push("plugin.json field `interface.capabilities` must be an array of strings");
  }
  if (!Array.isArray(manifest.interface.screenshots)) {
    errors.push("plugin.json field `interface.screenshots` must be an array");
  }
  const dp = manifest.interface.defaultPrompt;
  if (!Array.isArray(dp) || dp.length === 0 || !dp.every((p) => typeof p === "string" && p.trim())) {
    errors.push("plugin.json field `interface.defaultPrompt` must be a non-empty array of strings");
  }
  for (const field of ["websiteURL", "privacyPolicyURL", "termsOfServiceURL"]) {
    httpsUrl(manifest.interface, field, "interface");
  }
}

// Contract paths
if (manifest.mcpServers !== undefined) {
  if (typeof manifest.mcpServers !== "string") {
    errors.push("plugin.json field `mcpServers` must be a string path");
  } else {
    checkContractPath(manifest.mcpServers);
    if (manifest.mcpServers.endsWith(".mcp.json")) {
      const mcp = JSON.parse(readFileSync(resolve(CODEX_ROOT, manifest.mcpServers), "utf8"));
      if (!mcp.mcpServers || typeof mcp.mcpServers !== "object") {
        errors.push("`.mcp.json` must contain an `mcpServers` object");
      } else {
        for (const [name, cfg] of Object.entries(mcp.mcpServers)) {
          if (!cfg || typeof cfg !== "object" || typeof cfg.command !== "string") {
            errors.push(``.mcp.json` server \`${name}\` must specify a \`command\``);
          }
        }
      }
    }
  }
}
if (manifest.skills !== undefined) {
  if (typeof manifest.skills !== "string") {
    errors.push("plugin.json field `skills` must be a string path");
  } else {
    checkContractPath(manifest.skills);
  }
}
if (manifest.apps !== undefined) {
  errors.push("plugin.json field `apps` is not supported by this plugin (no remote app)");
}

// MCP server name must match the plugin name.
if (manifest.mcpServers && manifest.mcpServers.endsWith(".mcp.json")) {
  const mcp = JSON.parse(readFileSync(resolve(CODEX_ROOT, manifest.mcpServers), "utf8"));
  if (mcp.mcpServers && !(manifest.name in (mcp.mcpServers ?? {}))) {
    errors.push(``.mcp.json` must declare a server named \`${manifest.name}\``);
  }
}

if (errors.length > 0) {
  console.error("✖ plugin validation failed:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`✔ plugin validation OK (${manifest.name}@${manifest.version})`);
