/**
 * Module-level bridge singleton — shared across the runtime process the
 * same way `sessions.ts` keeps its in-memory session map. The dispatch
 * hook in `sessions.ts` imports `mcpBridge` from `mcp/index.ts`; it does
 * not construct `McpProcessManager` directly. Tests use `clearMcpBridge`
 * for teardown.
 */

import { McpProcessManager } from "./process-manager.js";
import { McpServerRegistry } from "./registry.js";
import type { McpServerSpec } from "./types.js";

let bridgeInstance: McpProcessManager | null = null;
let knownSessions = new Set<string>();

function getBridge(): McpProcessManager {
  if (!bridgeInstance) {
    bridgeInstance = new McpProcessManager({
      registry: new McpServerRegistry(),
    });
  }
  return bridgeInstance;
}

/**
 * Bridge proxy. Lazy-initialises the singleton on first use and tracks
 * sessions so `clearMcpBridge` can close every active child during test
 * teardown without exposing internal state.
 */
export const mcpBridge = {
  call(
    sessionId: string,
    serverId: string,
    tool: string,
    input: unknown,
    opts?: { timeoutMs?: number; specOverride?: McpServerSpec },
  ): ReturnType<McpProcessManager["call"]> {
    knownSessions.add(sessionId);
    return getBridge().call(sessionId, serverId, tool, input, opts);
  },
  async closeSession(sessionId: string): Promise<void> {
    knownSessions.delete(sessionId);
    if (!bridgeInstance) return;
    await bridgeInstance.closeSession(sessionId);
  },
  /** @internal Test-only diagnostic — exposes manager cache size. */
  getActiveProcessCount(): number {
    return bridgeInstance?.getActiveProcessCount() ?? 0;
  },
};

/**
 * Reset the singleton — closes every still-active session and clears
 * the instance so the next `mcpBridge.call(...)` constructs a fresh
 * manager. Mirrors the `clearSessionStore` pattern in `sessions.ts`.
 */
export async function clearMcpBridge(): Promise<void> {
  if (bridgeInstance) {
    for (const sessionId of [...knownSessions]) {
      await bridgeInstance.closeSession(sessionId);
    }
    bridgeInstance = null;
  }
  knownSessions = new Set<string>();
}
