/**
 * MCP server registry — resolves server IDs to spawn specs.
 *
 * Loads `mcp-servers.json` from `process.cwd()` on first call, caches the
 * parsed map, and answers `resolve(serverId)` from cache thereafter. The
 * file path is intentionally not part of the public API: a future
 * catalog-backed implementation must be drop-in via the same `resolve`
 * signature, with no other public fields or methods.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServerSpec } from "./types.js";

interface RawSpec {
  command?: unknown;
  env?: unknown;
  transport?: unknown;
}

function isValidSpec(value: unknown): value is McpServerSpec {
  if (!value || typeof value !== "object") return false;
  const spec = value as RawSpec;
  if (!Array.isArray(spec.command) || spec.command.length === 0) return false;
  if (!spec.command.every((part) => typeof part === "string")) return false;
  if (spec.transport !== "stdio") return false;
  if (spec.env !== undefined) {
    if (!spec.env || typeof spec.env !== "object") return false;
    for (const v of Object.values(spec.env as Record<string, unknown>)) {
      if (typeof v !== "string") return false;
    }
  }
  return true;
}

export class McpServerRegistry {
  // True private fields — invisible to Object.getOwnPropertyNames so the
  // public API stays the single `resolve` method (per C7).
  #cache: Map<string, McpServerSpec> | null = null;

  resolve(serverId: string): McpServerSpec | null {
    if (!this.#cache) this.#cache = McpServerRegistry.#load();
    return this.#cache.get(serverId) ?? null;
  }

  static #load(): Map<string, McpServerSpec> {
    const map = new Map<string, McpServerSpec>();
    const path = join(process.cwd(), "mcp-servers.json");
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return map;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return map;
    }
    if (!parsed || typeof parsed !== "object") return map;
    for (const [serverId, spec] of Object.entries(parsed)) {
      if (isValidSpec(spec)) {
        map.set(serverId, spec);
      }
    }
    return map;
  }
}
