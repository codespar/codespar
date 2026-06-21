/**
 * Public types for the OSS MCP bridge.
 *
 * Anything exported from this file is part of the public API surface of
 * `@codespar/core`. Internal manager state (cache shape, child handles,
 * etc.) lives in the implementation files and is not re-exported.
 */

/**
 * Tool descriptor as returned by an MCP server's `tools/list` JSON-RPC
 * method. Mirrors the canonical MCP spec shape — `name` is the tool id,
 * `description` is the human-readable summary, `inputSchema` is the
 * JSON Schema describing the tool's accepted input.
 *
 * Consumers (the chat-loop tool catalog) take this shape and re-emit it
 * to the LLM in the provider-specific tools[] format.
 */
export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/**
 * Wire shape returned by `mcpBridge.listTools` — same field set as the
 * MCP `tools/list` response plus structured failure surfacing so callers
 * can render a partial catalog when a single server fails.
 */
export interface ListToolsResult {
  success: boolean;
  tools: McpToolDescriptor[];
  error: string;
  server: string;
  duration: number;
}

/** A single MCP server entry — drives the spawn arguments verbatim. */
export interface McpServerSpec {
  /**
   * Argv of the child process, command first. Passed straight to
   * `child_process.spawn(command[0], command.slice(1), ...)`. The bridge
   * does not auto-prefix `npx` or rewrite this array in any way.
   */
  command: string[];
  /**
   * Per-spec environment variables. Merged onto `process.env` at spawn
   * time, with spec values winning on key conflict. Optional.
   */
  env?: Record<string, string>;
  /** Transport — only `"stdio"` is defined in this PR. */
  transport: "stdio";
}

/**
 * Wire shape returned to callers — intentionally aligned with the inline
 * shape used by `packages/core/src/server/routes/sessions.ts` so the
 * dispatch hook can return it directly.
 *
 * `error` is `null` on success and a non-empty string on failure. `null`
 * is the canonical no-error value, matching `ExecuteToolResponse.error`
 * (`z.string().nullable()`) in `@codespar/api-types` and the managed
 * runtime's envelope — so the same agent code sees the same shape on
 * either backend.
 */
export interface ToolResult {
  success: boolean;
  data: unknown;
  error: string | null;
  duration: number;
  server: string;
  tool: string;
  tool_call_id: string;
  called_at: string;
}

/**
 * Structured error codes surfaced via `ToolResult.error` when the bridge
 * fails internally. The dispatch hook in `sessions.ts` keeps using its
 * existing `Tool not registered: <name>` literal for prefix-not-in-servers.
 */
export const MCP_ERROR_CODES = {
  unknown_server: "mcp.unknown_server",
  parse_error: "mcp.parse_error",
  timeout: "mcp.timeout",
  child_exit: "mcp.child_exit",
  unknown_response_shape: "mcp.unknown_response_shape",
} as const;

export type McpErrorCode =
  (typeof MCP_ERROR_CODES)[keyof typeof MCP_ERROR_CODES];
