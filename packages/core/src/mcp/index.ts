/**
 * Public surface for the OSS MCP bridge.
 *
 * Consumers (including `sessions.ts`) must import only from this file —
 * never from `process-manager.ts` or `registry.ts` directly. This keeps
 * the boundary in one place and lets a future catalog-backed registry
 * land as a drop-in replacement.
 */

export type { McpServerSpec, ToolResult, McpErrorCode } from "./types.js";
export { MCP_ERROR_CODES } from "./types.js";
export { McpServerRegistry } from "./registry.js";
export { mcpBridge, clearMcpBridge } from "./bridge.js";
