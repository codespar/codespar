/**
 * MCP server registry — resolves server IDs to spawn specs.
 *
 * Looks up the config file in this order: `CODESPAR_MCP_SERVERS_PATH` if
 * the env var is set, otherwise `process.cwd()/mcp-servers.json`. If
 * neither exists or parses cleanly, the registry stays empty and
 * `resolve` returns `null` for every id — callers see the existing
 * `Tool not registered` shape and the runtime does not crash.
 *
 * The file path is intentionally not part of the public API: a future
 * catalog-backed implementation must be drop-in via the same `resolve`
 * signature, with no other public fields or methods.
 *
 * For session-scoped inline specs (no shared config file), callers pass
 * the spec to `mcpBridge.call(...)` via `opts.specOverride` and bypass
 * the registry entirely. See `sessions.ts` for the dispatch wiring.
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
    const override = process.env.CODESPAR_MCP_SERVERS_PATH;
    const path =
      override && override.length > 0
        ? override
        : join(process.cwd(), "mcp-servers.json");
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
