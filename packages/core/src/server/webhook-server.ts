/**
 * Webhook Server — Fastify HTTP server for receiving GitHub webhooks.
 *
 * Endpoints:
 * - POST /webhooks/github — receives and parses GitHub webhook payloads
 * - GET /health — returns server and agent health info
 *
 * Usage:
 *   const server = new WebhookServer({ port: 3000 });
 *   server.onCIEvent(async (event) => { ... });
 *   await server.start();
 */

import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { parseGitHubWebhook, type CIEvent } from "../webhooks/github-handler.js";
import type { AgentStatus } from "../types/agent.js";
import type { StorageProvider } from "../storage/types.js";

export interface WebhookServerConfig {
  port?: number;
  host?: string;
}

export type CIEventHandler = (event: CIEvent) => Promise<void>;

/** Interface for querying agent statuses from the supervisor */
export interface AgentStatusProvider {
  getAgentStatuses(): AgentStatus[];
}

export class WebhookServer {
  private app: FastifyInstance;
  private port: number;
  private host: string;
  private startedAt: Date;
  private eventHandlers: CIEventHandler[] = [];
  private agentCount: number = 0;
  private agentSupervisor: AgentStatusProvider | null = null;
  private storageProvider: StorageProvider | null = null;

  constructor(config?: WebhookServerConfig) {
    this.port = config?.port ?? parseInt(process.env["PORT"] ?? "3000", 10);
    this.host = config?.host ?? "0.0.0.0";
    this.startedAt = new Date();

    this.app = Fastify({ logger: false });
    this.app.register(cors, { origin: true });
    this.registerRoutes();
  }

  /** Set the agent supervisor for querying agent data */
  setAgentSupervisor(supervisor: AgentStatusProvider): void {
    this.agentSupervisor = supervisor;
  }

  /** Set the storage provider for querying audit logs */
  setStorageProvider(storage: StorageProvider): void {
    this.storageProvider = storage;
  }

  /** Register a handler that will be called for every parsed CI event */
  onCIEvent(handler: CIEventHandler): void {
    this.eventHandlers.push(handler);
  }

  /** Set the current agent count for health endpoint reporting */
  setAgentCount(count: number): void {
    this.agentCount = count;
  }

  /** Start listening for incoming webhooks */
  async start(): Promise<void> {
    this.startedAt = new Date();
    await this.app.listen({ port: this.port, host: this.host });
    console.log(
      `[webhook-server] Listening on http://${this.host}:${this.port}`
    );
  }

  /** Graceful shutdown */
  async stop(): Promise<void> {
    await this.app.close();
    console.log("[webhook-server] Stopped");
  }

  private registerRoutes(): void {
    // Health check
    this.app.get("/health", async (_request, _reply) => {
      const uptimeMs = Date.now() - this.startedAt.getTime();
      return {
        status: "ok",
        agents: this.agentCount,
        uptime: uptimeMs,
      };
    });

    // ── Dashboard API endpoints ──────────────────────────────────

    // System status overview
    this.app.get("/api/status", async (_request, _reply) => {
      const uptimeMs = Date.now() - this.startedAt.getTime();
      const statuses = this.agentSupervisor?.getAgentStatuses() ?? [];
      const activeCount = statuses.filter((s) => s.state === "ACTIVE").length;
      const totalTasks = statuses.reduce((sum, s) => sum + s.tasksHandled, 0);

      return {
        status: "ok",
        agents: {
          total: statuses.length,
          active: activeCount,
        },
        totalTasks,
        uptime: uptimeMs,
        startedAt: this.startedAt.toISOString(),
      };
    });

    // List all agents with status
    this.app.get("/api/agents", async (_request, _reply) => {
      const statuses = this.agentSupervisor?.getAgentStatuses() ?? [];
      return {
        agents: statuses.map((s) => ({
          id: s.id,
          name: s.id,
          project: s.projectId ?? "unknown",
          status: s.state,
          autonomy: s.autonomyLevel,
          type: s.type,
          tasksHandled: s.tasksHandled,
          uptimeMs: s.uptimeMs,
          lastActive: s.lastActiveAt?.toISOString() ?? null,
        })),
      };
    });

    // Get single agent detail
    this.app.get<{ Params: { id: string } }>(
      "/api/agents/:id",
      async (request, reply) => {
        const { id } = request.params;
        const statuses = this.agentSupervisor?.getAgentStatuses() ?? [];
        const agent = statuses.find((s) => s.id === id);

        if (!agent) {
          return reply.status(404).send({ error: "Agent not found" });
        }

        return {
          id: agent.id,
          name: agent.id,
          project: agent.projectId ?? "unknown",
          status: agent.state,
          autonomy: agent.autonomyLevel,
          type: agent.type,
          tasksHandled: agent.tasksHandled,
          uptimeMs: agent.uptimeMs,
          lastActive: agent.lastActiveAt?.toISOString() ?? null,
        };
      }
    );

    // List audit entries
    this.app.get<{ Querystring: { limit?: string; risk?: string } }>(
      "/api/audit",
      async (request, _reply) => {
        const limit = parseInt(request.query.limit ?? "20", 10);
        const riskFilter = request.query.risk ?? "all";

        if (!this.storageProvider) {
          return { entries: [], total: 0 };
        }

        // Query audit for all agents (empty string matches broad query)
        // FileStorage.queryAudit filters by actorId, so we query broadly
        const entries = await this.storageProvider.queryAudit("", limit);

        const filtered =
          riskFilter === "all"
            ? entries
            : entries.filter(
                (e) =>
                  e.metadata?.["risk"] === riskFilter
              );

        return {
          entries: filtered.map((e) => ({
            id: e.id,
            ts: e.timestamp.toISOString(),
            actor: e.actorId,
            actorType: e.actorType,
            action: e.action,
            result: e.result,
            detail: e.metadata?.["detail"] ?? "",
            risk: e.metadata?.["risk"] ?? "low",
            project: e.metadata?.["project"] ?? "unknown",
            hash: e.metadata?.["hash"] ?? "",
          })),
          total: filtered.length,
        };
      }
    );

    // GitHub webhook receiver
    this.app.post("/webhooks/github", async (request, reply) => {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        if (typeof value === "string") {
          headers[key.toLowerCase()] = value;
        }
      }

      const event = parseGitHubWebhook(headers, request.body);

      if (!event) {
        return reply.status(200).send({ received: true, processed: false });
      }

      // Dispatch to all registered handlers
      const errors: Error[] = [];
      for (const handler of this.eventHandlers) {
        try {
          await handler(event);
        } catch (err) {
          const error =
            err instanceof Error ? err : new Error(String(err));
          errors.push(error);
          console.error(
            `[webhook-server] Handler error: ${error.message}`
          );
        }
      }

      if (errors.length > 0) {
        return reply.status(500).send({
          received: true,
          processed: true,
          errors: errors.map((e) => e.message),
        });
      }

      return reply.status(200).send({ received: true, processed: true });
    });
  }
}
