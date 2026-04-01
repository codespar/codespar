/**
 * Shared types for route modules.
 *
 * Each route module exports a `registerXxxRoutes(route, ctx)` function
 * that receives the route helper and the server context.
 */

import type { FastifyReply } from "fastify";
import type { AgentStatusProvider, AgentFactory, CIEventHandler, DeployAlert } from "../webhook-server.js";
import type { StorageProvider } from "../../storage/types.js";
import type { ApprovalManager } from "../../approval/approval-manager.js";
import type { IdentityStore } from "../../auth/identity-store.js";
import type { VectorStore } from "../../memory/vector-store.js";
import type { NormalizedMessage } from "../../types/normalized-message.js";
import type { ChannelResponse } from "../../types/channel-adapter.js";
import type { EventBus } from "../../queue/event-bus.js";
import type { TaskQueue } from "../../queue/task-queue.js";

/** Route registration helper — registers on both /path and /v1/path */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RouteFn = (method: "get" | "post" | "delete", path: string, handler: any) => void;

/** Shared server context passed to all route modules */
export interface ServerContext {
  getOrgId(request: { headers: Record<string, string | string[] | undefined> }): string;
  getOrgStorage(orgId: string): StorageProvider;
  agentSupervisor: AgentStatusProvider | null;
  storageProvider: StorageProvider | null;
  approvalManager: ApprovalManager | null;
  agentFactory: AgentFactory | null;
  identityStore: IdentityStore | null;
  vectorStore: VectorStore | null;
  eventBus: EventBus | null;
  taskQueue: TaskQueue | null;
  startedAt: Date;
  agentCount: number;
  eventHandlers: CIEventHandler[];
  chatHandler: ((message: NormalizedMessage, orgId?: string) => Promise<ChannelResponse | null>) | null;
  alertHandler: ((alert: DeployAlert) => Promise<void>) | null;
  storageBaseDir: string;
  /** Vercel deploy dedup map */
  _vercelDedup: Map<string, number>;
  /** SSE broadcast */
  broadcastEvent(event: { type: string; data: unknown }, orgId?: string): void;
  /** SSE connections set */
  sseConnections: Set<{ reply: FastifyReply; orgId: string }>;
}
