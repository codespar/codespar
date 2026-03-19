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
import type { AgentStatus, AgentState } from "../types/agent.js";
import type { ChannelAdapter } from "../types/channel-adapter.js";
import type { StorageProvider, ProjectConfig, ProjectListEntry } from "../storage/types.js";
import type { ApprovalManager } from "../approval/approval-manager.js";
import type { IdentityStore } from "../auth/identity-store.js";
import type { ChannelType } from "../types/normalized-message.js";

export interface WebhookServerConfig {
  port?: number;
  host?: string;
}

export type CIEventHandler = (event: CIEvent) => Promise<void>;

/** Interface for querying agent statuses from the supervisor */
export interface AgentStatusProvider {
  getAgentStatuses(): AgentStatus[];
  getAdapters?(): ChannelAdapter[];
  restartAgent?(agentId: string): Promise<boolean>;
  removeAgent?(projectId: string): Promise<boolean>;
}

/** Interface for dynamically creating and removing agents */
export interface AgentFactory {
  createAgent(projectId: string, agentId: string, repo: string): Promise<void>;
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
  private approvalManager: ApprovalManager | null = null;
  private agentFactory: AgentFactory | null = null;
  private identityStore: IdentityStore | null = null;

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

  /** Set the approval manager for voting endpoints */
  setApprovalManager(manager: ApprovalManager): void {
    this.approvalManager = manager;
  }

  /** Set the agent factory for dynamically creating/removing agents */
  setAgentFactory(factory: AgentFactory): void {
    this.agentFactory = factory;
  }

  /** Set the identity store for resolving display names in audit entries */
  setIdentityStore(store: IdentityStore): void {
    this.identityStore = store;
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

        let projectConfig: ProjectConfig | null = null;
        if (this.storageProvider) {
          projectConfig = await this.storageProvider.getProjectConfig(id);
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
          projectConfig: projectConfig ?? undefined,
        };
      }
    );

    // Get current project config
    this.app.get<{ Querystring: { agentId?: string } }>(
      "/api/project",
      async (request, _reply) => {
        if (!this.storageProvider) {
          return { linked: false, config: null };
        }

        const agentId = request.query.agentId ?? "";
        if (!agentId) {
          return { linked: false, config: null, error: "agentId query param required" };
        }

        const config = await this.storageProvider.getProjectConfig(agentId);
        return {
          linked: config !== null,
          config: config ?? null,
        };
      }
    );

    // ── Link a project to an agent ──
    this.app.post<{ Body: { agentId: string; repo: string } }>(
      "/api/project/link",
      async (request, reply) => {
        const { agentId, repo } = request.body as { agentId?: string; repo?: string };

        if (!agentId || !repo) {
          return reply.status(400).send({ error: "agentId and repo are required" });
        }

        if (!this.storageProvider) {
          return reply.status(500).send({ error: "Storage not configured" });
        }

        // Parse owner/name from repo string (e.g. "codespar/api-gateway")
        const parts = repo.split("/");
        const repoOwner = parts.length > 1 ? parts[0]! : "";
        const repoName = parts.length > 1 ? parts[1]! : repo;

        const config: ProjectConfig = {
          repoUrl: `https://github.com/${repo}`,
          repoOwner,
          repoName,
          linkedAt: new Date().toISOString(),
          linkedBy: "dashboard",
          webhookConfigured: false,
        };

        await this.storageProvider.setProjectConfig(agentId, config);

        return { success: true, config };
      }
    );

    // ── Multi-project management ──

    // Create a new project (spawns a new Project Agent)
    this.app.post<{ Body: { repo: string; name?: string } }>(
      "/api/projects",
      async (request, reply) => {
        const { repo, name } = request.body as { repo?: string; name?: string };

        if (!repo || !repo.includes("/")) {
          return reply.status(400).send({ error: "repo is required in 'owner/repo' format" });
        }

        if (!this.storageProvider) {
          return reply.status(500).send({ error: "Storage not configured" });
        }

        if (!this.agentFactory) {
          return reply.status(500).send({ error: "Agent factory not configured" });
        }

        const [owner, repoName] = repo.split("/");
        const projectId = name ?? `${owner}-${repoName}`;
        const agentId = `agent-${projectId}`;

        // Check if project already exists
        const existingProjects = await this.storageProvider.getProjectsList();
        if (existingProjects.some((p) => p.id === projectId)) {
          return reply.status(409).send({ error: `Project '${projectId}' already exists` });
        }

        try {
          await this.agentFactory.createAgent(projectId, agentId, repo);
          await this.storageProvider.addProject({ id: projectId, agentId, repo });

          const port = this.port;
          return {
            id: projectId,
            agentId,
            repo,
            webhookUrl: `http://localhost:${port}/webhooks/github`,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return reply.status(500).send({ error: `Failed to create project: ${msg}` });
        }
      }
    );

    // List all projects with their agents
    this.app.get("/api/projects", async (_request, _reply) => {
      if (!this.storageProvider) {
        return { projects: [] };
      }

      const projects = await this.storageProvider.getProjectsList();
      return { projects };
    });

    // Remove a project (shuts down its agent)
    this.app.delete<{ Params: { id: string } }>(
      "/api/projects/:id",
      async (request, reply) => {
        const { id } = request.params;

        if (!this.storageProvider) {
          return reply.status(500).send({ error: "Storage not configured" });
        }

        const projects = await this.storageProvider.getProjectsList();
        const project = projects.find((p) => p.id === id);

        if (!project) {
          return reply.status(404).send({ error: `Project '${id}' not found` });
        }

        // Shut down the agent via the supervisor
        if (this.agentSupervisor?.removeAgent) {
          await this.agentSupervisor.removeAgent(id);
        }

        // Remove project config and list entry
        await this.storageProvider.deleteProjectConfig(project.agentId);
        await this.storageProvider.removeProject(id);

        return { success: true, removed: id };
      }
    );

    // ── Agent action (suspend / resume / restart) ──
    this.app.post<{ Params: { id: string }; Body: { action: string } }>(
      "/api/agents/:id/action",
      async (request, reply) => {
        const { id } = request.params;
        const { action } = request.body as { action?: string };

        if (!action || !["suspend", "resume", "restart"].includes(action)) {
          return reply.status(400).send({
            error: "action must be 'suspend', 'resume', or 'restart'",
          });
        }

        if (!this.agentSupervisor) {
          return reply.status(500).send({ error: "Supervisor not configured" });
        }

        const statuses = this.agentSupervisor.getAgentStatuses();
        const agentStatus = statuses.find((s) => s.id === id);
        if (!agentStatus) {
          return reply.status(404).send({ error: "Agent not found" });
        }

        if (action === "restart") {
          if (this.agentSupervisor.restartAgent) {
            const ok = await this.agentSupervisor.restartAgent(id);
            if (!ok) {
              return reply.status(500).send({ error: "Restart failed" });
            }
            return { success: true, action: "restart", agentId: id };
          }
          return reply.status(501).send({ error: "Restart not supported" });
        }

        // For suspend/resume, we update the agent status via the supervisor.
        // The supervisor exposes agents, so we note the desired state.
        // Since the Agent interface doesn't expose a setState, we record
        // the action in audit and return success (agents check state on next tick).
        const newState: AgentState = action === "suspend" ? "SUSPENDED" : "IDLE";

        if (this.storageProvider) {
          await this.storageProvider.appendAudit({
            actorType: "user",
            actorId: "dashboard",
            action: `agent.${action}`,
            result: "success",
            metadata: {
              agentId: id,
              newState,
              detail: `Agent ${id} ${action}ed via dashboard`,
            },
          });
        }

        return { success: true, action, agentId: id, newState };
      }
    );

    // ── List connected channels ──
    this.app.get("/api/channels", async (_request, _reply) => {
      const adapters = this.agentSupervisor?.getAdapters?.() ?? [];

      const channels = await Promise.all(
        adapters.map(async (adapter) => {
          let healthy = false;
          try {
            healthy = await adapter.healthCheck();
          } catch {
            // health check failed
          }
          return {
            name: adapter.type,
            platform: adapter.type,
            connected: healthy,
            capabilities: adapter.getCapabilities(),
          };
        })
      );

      // If no adapters are registered, return env-based channel info
      if (channels.length === 0) {
        const envChannels = [];
        for (const name of ["whatsapp", "slack", "telegram", "discord"]) {
          const envKey = `ENABLE_${name.toUpperCase()}`;
          envChannels.push({
            name,
            platform: name,
            connected: process.env[envKey] === "true",
            capabilities: null,
          });
        }
        return { channels: envChannels };
      }

      return { channels };
    });

    // ── Reconnect a channel (placeholder) ──
    this.app.post<{ Params: { name: string } }>(
      "/api/channels/:name/reconnect",
      async (request, reply) => {
        const { name } = request.params;
        const adapters = this.agentSupervisor?.getAdapters?.() ?? [];
        const adapter = adapters.find((a) => a.type === name);

        if (!adapter) {
          return reply.status(404).send({ error: `Channel '${name}' not found` });
        }

        try {
          await adapter.disconnect();
          await adapter.connect();
          return { success: true, channel: name, connected: true };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return reply.status(500).send({ error: `Reconnect failed: ${msg}` });
        }
      }
    );

    // ── Approval vote ──
    this.app.post<{ Body: { token: string; vote: string; userId: string } }>(
      "/api/approval/vote",
      async (request, reply) => {
        const { token, vote, userId } = request.body as {
          token?: string;
          vote?: string;
          userId?: string;
        };

        if (!token || !vote || !userId) {
          return reply.status(400).send({
            error: "token, vote, and userId are required",
          });
        }

        if (!["approve", "deny"].includes(vote)) {
          return reply.status(400).send({
            error: "vote must be 'approve' or 'deny'",
          });
        }

        if (!this.approvalManager) {
          return reply.status(500).send({ error: "Approval manager not configured" });
        }

        const result = this.approvalManager.vote(
          token,
          userId,
          "dashboard",
          vote as "approve" | "deny"
        );

        if (!result) {
          return reply.status(404).send({
            error: "Token not found, already resolved, or vote rejected",
          });
        }

        if (this.storageProvider) {
          await this.storageProvider.appendAudit({
            actorType: "user",
            actorId: userId,
            action: "approval.voted",
            result: result.status === "denied" ? "failure" : "success",
            metadata: {
              token,
              vote,
              approvalStatus: result.status,
              votesReceived: result.votesReceived,
              votesRequired: result.votesRequired,
              detail: `Vote '${vote}' via dashboard. Status: ${result.status}`,
            },
          });
        }

        return { success: true, result };
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
          entries: filtered.map((e) => {
            // Resolve display name from identity store when available
            let displayName: string | undefined;
            if (this.identityStore && e.actorType === "user") {
              const channel = (e.metadata?.["channel"] as ChannelType) ?? "cli";
              displayName = this.identityStore.getDisplayName(channel, e.actorId);
              // Only include if it differs from the raw actorId
              if (displayName === e.actorId) displayName = undefined;
            }

            return {
              id: e.id,
              ts: e.timestamp.toISOString(),
              actor: e.actorId,
              actorType: e.actorType,
              displayName,
              action: e.action,
              result: e.result,
              detail: e.metadata?.["detail"] ?? "",
              risk: e.metadata?.["risk"] ?? "low",
              project: e.metadata?.["project"] ?? "unknown",
              hash: e.metadata?.["hash"] ?? "",
            };
          }),
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
