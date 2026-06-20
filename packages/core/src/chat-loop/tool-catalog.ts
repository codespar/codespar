/**
 * Tool catalog for the OSS chat loop.
 *
 * Given a session and the in-process MCP bridge, iterate every
 * connected MCP server (`session.metadata.servers`), call `tools/list`
 * per server, and
 * return an Anthropic-shape `tools[]` array. Tool names are namespaced
 * as `${serverId}__${toolName}` so the loop's dispatch path can recover
 * the routing from the LLM's `tool_use.name` field without an extra
 * lookup. The double-underscore separator is chosen because Anthropic's
 * tool-name regex (`^[a-zA-Z0-9_-]{1,128}$`) forbids `/`, and because
 * single `-` collides with server IDs that contain hyphens
 * (`nuvem-fiscal`, `z-api`) while single `_` collides with MCP tool
 * names that use snake_case (`create_nfse`, `send_text`). Double `_` is
 * unambiguous in both directions.
 *
 * Servers that fail to list (process crash, unknown_server, parse
 * error) are skipped with a structured warning — the loop continues
 * with a partial catalog rather than failing the whole turn.
 *
 * Alongside the raw MCP tools, the catalog also advertises any
 * meta-tools registered through the plugin registry's `MetaToolHook`
 * seam (`pluginRegistry.metaToolDefinitions()`). This mirrors the
 * `/execute` route, which dispatches registered meta-tools by name —
 * surfacing them here lets the LLM call them in `session.send()` too.
 * With no registrant the registry returns an empty list, so the
 * default OSS catalog stays a thin pass-through of raw MCP tools.
 * Meta-tool names carry no `__` separator, so they never collide with
 * the namespaced `${serverId}__${toolName}` form below and the loop's
 * dispatch path can tell the two apart.
 */

import type { McpServerSpec } from "../mcp/index.js";
import { mcpBridge } from "../mcp/index.js";
import { createLogger } from "../observability/logger.js";
import { pluginRegistry, type PluginRegistry } from "../plugins/registry.js";
import type { Session } from "../storage/types.js";

const log = createLogger("chat-loop:tool-catalog");

/**
 * Anthropic tool shape — matches the SDK's `Tool` interface without
 * importing it directly so the catalog stays decoupled from the SDK's
 * deeply-nested type hierarchy.
 */
export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    [k: string]: unknown;
  };
}

/** Read the `servers` list a session was created with (kept in metadata). */
function readServers(session: Session): string[] {
  const raw = session.metadata?.["servers"];
  return Array.isArray(raw) ? (raw.filter((s) => typeof s === "string") as string[]) : [];
}

/** Read inline server specs off a session, when the caller passed
 *  `server_specs` to POST /sessions. Stored on `metadata.serverSpecs`. */
function readServerSpecs(session: Session): Record<string, McpServerSpec> | undefined {
  const raw = session.metadata?.["serverSpecs"];
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, McpServerSpec>)
    : undefined;
}

/** Coerce an MCP `inputSchema` field into the Anthropic
 *  `input_schema` shape. The MCP spec uses canonical JSON Schema with
 *  `type: "object"` at the top level for tool inputs; we accept that
 *  unchanged and fall back to a permissive empty object when the
 *  server omits the field. */
function normaliseInputSchema(raw: unknown): AnthropicTool["input_schema"] {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (obj.type === "object") {
      return obj as AnthropicTool["input_schema"];
    }
  }
  // Permissive fallback — let the LLM emit any JSON object input and
  // rely on the MCP server's own validation downstream.
  return { type: "object" };
}

/** The slice of the plugin registry the catalog needs: the advertised
 *  definitions of every registered meta-tool. Narrowed to the single
 *  method so tests can inject a stub without standing up the whole
 *  registry. */
type MetaToolCatalogSource = Pick<PluginRegistry, "metaToolDefinitions">;

/**
 * Build the Anthropic `tools[]` array for the given session by asking
 * every connected MCP server what tools it exposes, then appending the
 * definitions of any registered meta-tools so the LLM can call them in
 * the same turn.
 *
 * `bridge` defaults to the singleton; tests pass an override so they
 * can verify catalog construction without a live child. `registry`
 * likewise defaults to the singleton `pluginRegistry`; tests inject a
 * stub to control which meta-tools are advertised.
 */
export async function buildToolCatalog(
  session: Session,
  bridge: Pick<typeof mcpBridge, "listTools"> = mcpBridge,
  registry: MetaToolCatalogSource = pluginRegistry,
): Promise<AnthropicTool[]> {
  const servers = readServers(session);
  const specs = readServerSpecs(session);

  const tools: AnthropicTool[] = [];
  for (const serverId of servers) {
    const opts = specs?.[serverId] ? { specOverride: specs[serverId] } : undefined;
    const result = await bridge.listTools(session.id, serverId, opts);
    if (!result.success) {
      log.warn("tool catalog: server failed to list tools", {
        sessionId: session.id,
        serverId,
        error: result.error,
      });
      continue;
    }
    for (const tool of result.tools) {
      tools.push({
        name: `${serverId}__${tool.name}`,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        input_schema: normaliseInputSchema(tool.inputSchema),
      });
    }
  }

  // Registered meta-tools are callable by their bare name (no `__`),
  // dispatched through `pluginRegistry.getMetaTool(name)` by the loop —
  // the same name the `/execute` route routes through Branch C. With no
  // registrant this list is empty and the catalog is raw MCP tools only.
  for (const def of registry.metaToolDefinitions()) {
    tools.push({
      name: def.name,
      description: def.description,
      input_schema: def.input_schema,
    });
  }

  return tools;
}

/**
 * Split a namespaced tool name back into `(serverId, toolName)`. The
 * loop produces names with `${serverId}__${toolName}`; the dispatch
 * path uses this to route through the MCP bridge.
 *
 * Splits on the first `__` only — MCP tool names that contain `_`
 * (snake_case like `create_nfse`) survive the round-trip intact, as do
 * tool names that happen to contain `__` themselves (the first `__`
 * boundary wins).
 */
export function splitNamespacedToolName(
  name: string,
): { serverId: string; toolName: string } | null {
  const sepIdx = name.indexOf("__");
  if (sepIdx <= 0 || sepIdx >= name.length - 2) return null;
  return {
    serverId: name.slice(0, sepIdx),
    toolName: name.slice(sepIdx + 2),
  };
}
