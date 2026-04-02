/**
 * Agent routes — CRUD, actions, status, memory, identity, agent-types.
 */

import { randomUUID } from "node:crypto";
import { getRegisteredTypes, getAgentFactory, isRegisteredType, getAllAgentMetadata, getAgentMetadata } from "../../agents/agent-registry.js";
import { createLogger } from "../../observability/logger.js";
import { metrics } from "../../observability/metrics.js";
import { parseIntent } from "../../router/intent-parser.js";
import type { RouteFn, ServerContext } from "./types.js";
import type { AgentConfig, AgentState, AutonomyLevel } from "../../types/agent.js";
import { createAgentBody, agentActionBody, linkProjectBody, createProjectBody, parseBody } from "./schemas.js";
import type { ProjectConfig } from "../../storage/types.js";
import { GitHubClient } from "../../github/github-client.js";
import { broadcastEvent } from "../webhook-server.js";

const log = createLogger("routes/agents");

export function registerAgentRoutes(route: RouteFn, ctx: ServerContext): void {
    // ── Dashboard API endpoints ──────────────────────────────────

    // System status overview
    route("get", "/api/status", async (_request: any, _reply: any) => {
      const uptimeMs = Date.now() - ctx.startedAt.getTime();
      const statuses = ctx.agentSupervisor?.getAgentStatuses() ?? [];
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
        startedAt: ctx.startedAt.toISOString(),
      };
    });


    // List all registered agent types (built-in + custom plugins)
    route("get", "/api/agent-types", async (_request: any, _reply: any) => {
      return { types: getRegisteredTypes() };
    });

    // List all agents with status (filtered by org, optionally by project)
    route("get", "/api/agents", async (request: any, _reply: any) => {
      const orgId = ctx.getOrgId(request);
      const projectFilter = (request.query as Record<string, string>)?.project ?? "";
      const statuses = ctx.agentSupervisor?.getAgentStatuses() ?? [];

      // Filter agents by org — show org-specific agents first,
      // fall back to default/unscoped agents if the org has none yet.
      // This handles the common case where agents were created before
      // multi-tenant org IDs were assigned (e.g., via Setup page).
      let filtered = orgId === "default"
        ? statuses.filter((s) => !s.orgId || s.orgId === "default")
        : statuses.filter((s) => s.orgId === orgId);

      // Fallback: if org has no agents, include default/unscoped agents
      if (filtered.length === 0 && orgId !== "default") {
        filtered = statuses.filter((s) => !s.orgId || s.orgId === "default");
      }

      // Apply project filter (if specified)
      if (projectFilter) {
        filtered = filtered.filter((s) => {
          const agentProject = s.projectId ?? "";
          return agentProject === projectFilter || agentProject.includes(projectFilter);
        });
      }

      return {
        agents: filtered.map((s) => ({
          id: s.id,
          name: s.id,
          project: s.projectId ?? "unknown",
          status: s.state,
          autonomy: s.autonomyLevel,
          type: s.type,
          orgId: s.orgId,
          tasksHandled: s.tasksHandled,
          uptimeMs: s.uptimeMs,
          lastActive: s.lastActiveAt?.toISOString() ?? null,
        })),
      };
    });

    // Get single agent detail
    route("get", "/api/agents/:id",
      async (request: any, reply: any) => {
        const { id } = request.params;
        const statuses = ctx.agentSupervisor?.getAgentStatuses() ?? [];
        const agent = statuses.find((s) => s.id === id);

        if (!agent) {
          return reply.status(404).send({ error: "Agent not found" });
        }

        let projectConfig: ProjectConfig | null = null;
        if (ctx.storageProvider) {
          projectConfig = await ctx.storageProvider.getProjectConfig(id);
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

    // Create a new agent dynamically
    route("post", "/api/agents",
      async (request: any, reply: any) => {
        const { name, type, projectId, autonomyLevel } = request.body as {
          name?: string;
          type?: string;
          projectId?: string;
          autonomyLevel?: number;
        };

        // Validate name: required, alphanumeric + hyphens, 3-50 chars
        if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9-]{1,48}[a-zA-Z0-9]$/.test(name)) {
          return reply.status(400).send({
            error: "name is required and must be 3-50 characters (alphanumeric and hyphens, cannot start/end with hyphen)",
          });
        }

        // Validate type: required and must be a registered agent type
        if (!type) {
          return reply.status(400).send({ error: "type is required" });
        }
        if (!isRegisteredType(type)) {
          return reply.status(400).send({
            error: `Unknown agent type '${type}'. Registered types: ${getRegisteredTypes().join(", ")}`,
          });
        }

        // Validate autonomy level if provided
        const level = (autonomyLevel ?? 1) as AutonomyLevel;
        if (typeof level !== "number" || !Number.isInteger(level) || level < 0 || level > 5) {
          return reply.status(400).send({ error: "autonomyLevel must be an integer 0-5" });
        }

        if (!ctx.agentSupervisor) {
          return reply.status(500).send({ error: "Supervisor not configured" });
        }

        // Check for duplicate name
        const existingStatuses = ctx.agentSupervisor.getAgentStatuses();
        if (existingStatuses.some((s) => s.id === name)) {
          return reply.status(409).send({ error: `Agent '${name}' already exists` });
        }

        // Build agent config and create via registry factory
        const agentConfig: AgentConfig = {
          id: name,
          type: type as AgentConfig["type"],
          projectId: projectId ?? name,
          autonomyLevel: level,
        };

        const factory = getAgentFactory(type);
        if (!factory) {
          return reply.status(500).send({ error: `No factory registered for type '${type}'` });
        }

        try {
          const agent = factory(agentConfig, ctx.storageProvider ?? undefined);
          const spawnProjectId = projectId ?? name;

          if (!ctx.agentSupervisor.spawnAgent) {
            return reply.status(501).send({ error: "Supervisor does not support spawning agents" });
          }

          await ctx.agentSupervisor.spawnAgent(spawnProjectId, agent);

          // Audit trail
          if (ctx.storageProvider) {
            await ctx.storageProvider.appendAudit({
              actorType: "user",
              actorId: "api",
              action: "agent.created",
              result: "success",
              metadata: {
                agentId: name,
                type,
                projectId: spawnProjectId,
                autonomyLevel: level,
                detail: `Agent '${name}' (type: ${type}, L${level}) created via API`,
              },
            });
          }

          broadcastEvent({ type: "agent.created", data: { id: name, name, type } });

          return {
            success: true,
            agent: {
              id: name,
              name,
              type,
              status: "IDLE",
              autonomyLevel: level,
              projectId: spawnProjectId,
            },
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error("Failed to create agent", { name, type, error: msg });
          return reply.status(500).send({ error: `Failed to create agent: ${msg}` });
        }
      }
    );

    // Remove/shutdown an agent by id
    route("delete", "/api/agents/:id",
      async (request: any, reply: any) => {
        const { id } = request.params;

        if (!ctx.agentSupervisor) {
          return reply.status(500).send({ error: "Supervisor not configured" });
        }

        // Verify agent exists
        const statuses = ctx.agentSupervisor.getAgentStatuses();
        const agent = statuses.find((s) => s.id === id);
        if (!agent) {
          return reply.status(404).send({ error: "Agent not found" });
        }

        // Remove via supervisor (uses projectId, which may differ from agent id)
        const projectId = agent.projectId ?? id;
        if (!ctx.agentSupervisor.removeAgent) {
          return reply.status(501).send({ error: "Supervisor does not support removing agents" });
        }

        const removed = await ctx.agentSupervisor.removeAgent(projectId);
        if (!removed) {
          return reply.status(500).send({ error: `Failed to remove agent '${id}'` });
        }

        // Audit trail
        if (ctx.storageProvider) {
          await ctx.storageProvider.appendAudit({
            actorType: "user",
            actorId: "api",
            action: "agent.removed",
            result: "success",
            metadata: {
              agentId: id,
              projectId,
              detail: `Agent '${id}' removed via API`,
            },
          });
        }

        broadcastEvent({ type: "agent.removed", data: { id } });

        return { success: true, removed: id };
      }
    );

    // Get current project config (org-scoped)
    route("get", "/api/project",
      async (request: any, reply: any) => {
        if (!ctx.storageProvider) {
          return { linked: false, config: null };
        }

        const agentId = request.query.agentId ?? "";
        if (!agentId) {
          return { linked: false, config: null, error: "agentId query param required" };
        }

        const orgId = ctx.getOrgId(request);

        // Verify the agent belongs to this org
        if (orgId !== "default") {
          const orgStorage = ctx.getOrgStorage(orgId);
          const orgProjects = await orgStorage.getProjectsList();
          const belongsToOrg = orgProjects.some((p) => p.agentId === agentId);
          if (!belongsToOrg) {
            reply.code(404).send({ error: "Agent not found in this organization" });
            return;
          }
        }

        const config = await ctx.storageProvider.getProjectConfig(agentId);
        return {
          linked: config !== null,
          config: config ?? null,
        };
      }
    );

    // ── Link a project to an agent ──
    route("post", "/api/project/link",
      async (request: any, reply: any) => {
        const { agentId, repo } = request.body as { agentId?: string; repo?: string };

        if (!agentId || !repo) {
          return reply.status(400).send({ error: "agentId and repo are required" });
        }

        if (!ctx.storageProvider) {
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

        await ctx.storageProvider.setProjectConfig(agentId, config);

        return { success: true, config };
      }
    );

    // ── Multi-project management ──

    // Create a new project (spawns a new Project Agent, org-scoped)
    route("post", "/api/projects",
      async (request: any, reply: any) => {
        const { repo, name } = request.body as { repo?: string; name?: string };

        if (!repo || !repo.includes("/")) {
          return reply.status(400).send({ error: "repo is required in 'owner/repo' format" });
        }

        const orgId = ctx.getOrgId(request);
        const storage = ctx.getOrgStorage(orgId);

        if (!ctx.agentFactory) {
          return reply.status(500).send({ error: "Agent factory not configured" });
        }

        const [owner, repoName] = repo.split("/");
        const projectId = name ?? repoName;
        const agentId = `agent-${projectId}`;

        // Check if project already exists within this org
        const existingProjects = await storage.getProjectsList();
        if (existingProjects.some((p) => p.id === projectId)) {
          return reply.status(409).send({ error: `Project '${projectId}' already exists` });
        }

        try {
          await ctx.agentFactory.createAgent(projectId, agentId, repo, orgId);
          await storage.addProject({ id: projectId, agentId, repo });

          // Auto-configure GitHub webhook
          const WEBHOOK_BASE_URL =
            process.env.WEBHOOK_BASE_URL ||
            "https://codespar-production.up.railway.app";
          const webhookUrl = `${WEBHOOK_BASE_URL}/webhooks/github`;

          const github = new GitHubClient();
          let webhookConfigured = false;
          if (github.isConfigured() && owner && repoName) {
            const webhook = await github.createWebhook(
              owner,
              repoName,
              webhookUrl,
            );
            webhookConfigured = !!webhook;
          }

          return {
            id: projectId,
            agentId,
            repo,
            orgId,
            webhookUrl,
            webhookConfigured,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return reply.status(500).send({ error: `Failed to create project: ${msg}` });
        }
      }
    );

    // List all projects with their agents (org-scoped)
    route("get", "/api/projects", async (request: any, _reply: any) => {
      const orgId = ctx.getOrgId(request);
      const storage = ctx.getOrgStorage(orgId);

      const projects = await storage.getProjectsList();
      return { projects };
    });

    // Remove a project (shuts down its agent, org-scoped)
    route("delete", "/api/projects/:id",
      async (request: any, reply: any) => {
        const { id } = request.params;
        const orgId = ctx.getOrgId(request);
        const storage = ctx.getOrgStorage(orgId);

        const projects = await storage.getProjectsList();
        const project = projects.find((p) => p.id === id);

        if (!project) {
          return reply.status(404).send({ error: `Project '${id}' not found` });
        }

        // Shut down the agent via the supervisor
        if (ctx.agentSupervisor?.removeAgent) {
          await ctx.agentSupervisor.removeAgent(id);
        }

        // Remove project config and list entry
        await storage.deleteProjectConfig(project.agentId);
        await storage.removeProject(id);

        return { success: true, removed: id };
      }
    );

    // ── Agent action (suspend / resume / restart) ──
    route("post", "/api/agents/:id/action",
      async (request: any, reply: any) => {
        const { id } = request.params;
        const { action } = request.body as { action?: string };

        if (!action || !["suspend", "resume", "restart", "set_autonomy"].includes(action)) {
          return reply.status(400).send({
            error: "action must be 'suspend', 'resume', 'restart', or 'set_autonomy'",
          });
        }

        if (!ctx.agentSupervisor) {
          return reply.status(500).send({ error: "Supervisor not configured" });
        }

        const statuses = ctx.agentSupervisor.getAgentStatuses();
        const agentStatus = statuses.find((s) => s.id === id);
        if (!agentStatus) {
          return reply.status(404).send({ error: "Agent not found" });
        }

        if (action === "set_autonomy") {
          const level = (request.body as { level?: number }).level;
          if (typeof level !== "number" || level < 0 || level > 5) {
            return reply.status(400).send({ error: "level must be 0-5" });
          }

          // Update agent autonomy level in memory
          (agentStatus as unknown as Record<string, unknown>).autonomyLevel = level;

          // Persist via storage
          if (ctx.storageProvider) {
            await ctx.storageProvider.setMemory(id, "autonomyLevel", level);
            await ctx.storageProvider.saveAgentState(id, {
              agentId: id,
              state: "active",
              autonomyLevel: level,
              updatedAt: new Date().toISOString(),
            });
            await ctx.storageProvider.appendAudit({
              actorType: "user",
              actorId: "dashboard",
              action: "agent.set_autonomy",
              result: "success",
              metadata: {
                agentId: id,
                level,
                detail: `Autonomy set to L${level} via dashboard`,
              },
            });
          }

          const labels = ["Passive", "Notify", "Suggest", "Auto-Low", "Auto-Med", "Full Auto"];
          broadcastEvent({ type: "agent.status", data: { id, status: `L${level}` } });
          return {
            success: true,
            action: "set_autonomy",
            agentId: id,
            level,
            label: labels[level] ?? "Unknown",
          };
        }

        if (action === "restart") {
          if (ctx.agentSupervisor.restartAgent) {
            const ok = await ctx.agentSupervisor.restartAgent(id);
            if (!ok) {
              return reply.status(500).send({ error: "Restart failed" });
            }
            broadcastEvent({ type: "agent.status", data: { id, status: "restarted" } });
            return { success: true, action: "restart", agentId: id };
          }
          return reply.status(501).send({ error: "Restart not supported" });
        }

        // For suspend/resume, we update the agent status via the supervisor.
        // The supervisor exposes agents, so we note the desired state.
        // Since the Agent interface doesn't expose a setState, we record
        // the action in audit and return success (agents check state on next tick).
        const newState: AgentState = action === "suspend" ? "SUSPENDED" : "IDLE";

        if (ctx.storageProvider) {
          // Persist agent state so it survives restart
          const currentLevel = (agentStatus as unknown as Record<string, unknown>).autonomyLevel as number ?? 1;
          await ctx.storageProvider.saveAgentState(id, {
            agentId: id,
            state: action === "suspend" ? "suspended" : "active",
            autonomyLevel: currentLevel,
            updatedAt: new Date().toISOString(),
          });
          await ctx.storageProvider.appendAudit({
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

        broadcastEvent({ type: "agent.status", data: { id, status: newState } });

        return { success: true, action, agentId: id, newState };
      }
    );

    // ── A2A Agent Cards ──────────────────────────────────────────────

    // List all agent metadata in A2A Agent Card format
    route("get", "/api/agent-cards", async (_request: any, _reply: any) => {
      const allMetadata = getAllAgentMetadata();
      const baseUrl = process.env.WEBHOOK_BASE_URL || "https://codespar-production.up.railway.app";

      return {
        agents: allMetadata.map((meta) => ({
          name: meta.displayName,
          description: meta.description,
          url: `${baseUrl}/api/agent-cards/${meta.type}`,
          version: "1.0.0",
          lifecycle: meta.lifecycle,
          capabilities: {
            streaming: meta.capabilities.streaming,
            pushNotifications: meta.capabilities.pushNotifications,
            autonomyLevels: meta.capabilities.autonomyLevels,
          },
          skills: meta.skills.map((skill) => ({
            id: skill.id,
            name: skill.name,
            description: skill.description,
            inputModes: skill.inputModes,
            outputModes: skill.outputModes,
          })),
          requiredServices: meta.requiredServices,
        })),
      };
    });

    // Get a single agent card by type
    route("get", "/api/agent-cards/:type", async (request: any, reply: any) => {
      const { type } = request.params;
      const meta = getAgentMetadata(type);
      if (!meta) {
        return reply.status(404).send({ error: `No agent card found for type '${type}'` });
      }

      const baseUrl = process.env.WEBHOOK_BASE_URL || "https://codespar-production.up.railway.app";
      return {
        name: meta.displayName,
        description: meta.description,
        url: `${baseUrl}/api/agent-cards/${meta.type}`,
        version: "1.0.0",
        lifecycle: meta.lifecycle,
        capabilities: {
          streaming: meta.capabilities.streaming,
          pushNotifications: meta.capabilities.pushNotifications,
          autonomyLevels: meta.capabilities.autonomyLevels,
        },
        skills: meta.skills.map((skill) => ({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          inputModes: skill.inputModes,
          outputModes: skill.outputModes,
        })),
        requiredServices: meta.requiredServices,
      };
    });

}
