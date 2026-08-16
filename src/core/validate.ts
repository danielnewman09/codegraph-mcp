/**
 * Lightweight JSON Schema validator for the schema constructs used by the
 * canonical tool catalog (TypeBox emits these).  The MCP SDK in current
 * versions only accepts Zod schemas for `inputSchema`, so the MCP harness
 * validates against the JSON Schema form with this tiny validator instead
 * of maintaining parallel Zod schemas.
 *
 * Supported constructs (all the catalog uses):
 *   - object + properties + required
 *   - string + enum / const
 *   - number, boolean, array + items
 *   - anyOf
 *
 * Returns null when the value is valid, or a human-readable message.
 */

import type { JsonObject } from "./types.js";

export function validateAgainstSchema(schema: JsonObject, value: unknown): string | null {
  // anyOf: valid if any branch accepts.
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    const any = schema.anyOf;
    for (const branch of any) {
      if (validateAgainstSchema(branch as JsonObject, value) === null) return null;
    }
    return `value does not match any allowed option`;
  }

  const type = schema.type;

  if (type === "object" || (type === undefined && schema.properties)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return `expected an object, got ${typeof value}`;
    }
    const obj = value as Record<string, unknown>;
    const required = (schema.required as string[] | undefined) ?? [];
    for (const key of required) {
      if (!(key in obj) || obj[key] === undefined) {
        return `missing required property '${key}'`;
      }
    }
    const properties = (schema.properties as Record<string, JsonObject> | undefined) ?? {};
    for (const [key, propSchema] of Object.entries(properties)) {
      if (obj[key] === undefined) continue; // optional / absent
      const msg = validateAgainstSchema(propSchema, obj[key]);
      if (msg !== null) return `'${key}': ${msg}`;
    }
    return null;
  }

  if (type === "string") {
    if (typeof value !== "string") return `expected a string, got ${typeof value}`;
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      return `'${value}' is not one of ${schema.enum.map((e) => `'${e}'`).join(", ")}`;
    }
    if (schema.const !== undefined && value !== schema.const) {
      return `expected '${schema.const}', got '${value}'`;
    }
    return null;
  }

  if (type === "number" || type === "integer") {
    if (typeof value !== "number") return `expected a number, got ${typeof value}`;
    if (type === "integer" && !Number.isInteger(value)) return `expected an integer`;
    return null;
  }

  if (type === "boolean") {
    return typeof value === "boolean" ? null : `expected a boolean, got ${typeof value}`;
  }

  if (type === "array") {
    if (!Array.isArray(value)) return `expected an array, got ${typeof value}`;
    if (schema.items) {
      const itemSchema = schema.items as JsonObject;
      for (let i = 0; i < value.length; i++) {
        const msg = validateAgainstSchema(itemSchema, value[i]);
        if (msg !== null) return `item ${i}: ${msg}`;
      }
    }
    return null;
  }

  // Unknown schema construct — treat as valid (no further constraints).
  return null;
}
