/**
 * Public types for the OSS MCP bridge.
 *
 * Anything exported from this file is part of the public API surface of
 * `@codespar/core`. Internal manager state (cache shape, child handles,
 * etc.) lives in the implementation files and is not re-exported.
 */

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
 */
export interface ToolResult {
  success: boolean;
  data: unknown;
  error: string;
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
