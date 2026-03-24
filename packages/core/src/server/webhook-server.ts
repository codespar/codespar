/**
 * Webhook Server — Fastify HTTP server for receiving GitHub webhooks.
 *
 * Endpoints:
 * - POST /webhooks/github — receives and parses GitHub webhook payloads
 * - POST /webhooks/vercel — receives Vercel deploy event webhooks
 * - POST /webhooks/deploy — generic deploy webhook for any CI/CD service
 * - GET /health — returns server and agent health info
 * - GET /api/webhooks/status — returns which webhook secrets are configured
 *
 * Usage:
 *   const server = new WebhookServer({ port: 3000 });
 *   server.onCIEvent(async (event) => { ... });
 *   await server.start();
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import cors from "@fastify/cors";
import { parseGitHubWebhook, type CIEvent } from "../webhooks/github-handler.js";
import { getRegisteredTypes, getAgentFactory, isRegisteredType } from "../agents/agent-registry.js";
import { createLogger } from "../observability/logger.js";
import { metrics } from "../observability/metrics.js";
import { scheduler } from "../scheduler/scheduler.js";

const log = createLogger("webhook-server");
const newsletterLog = createLogger("newsletter");
import { GitHubClient } from "../github/github-client.js";
import type { AgentStatus, AgentState, AgentConfig, AutonomyLevel } from "../types/agent.js";
import type { ChannelAdapter } from "../types/channel-adapter.js";
import type { StorageProvider, ProjectConfig, ProjectListEntry, SlackInstallation, AgentStateEntry } from "../storage/types.js";
import { FileStorage } from "../storage/file-storage.js";
import type { ApprovalManager } from "../approval/approval-manager.js";
import type { IdentityStore } from "../auth/identity-store.js";
import type { VectorStore } from "../memory/vector-store.js";
import type { ChannelType, NormalizedMessage } from "../types/normalized-message.js";
import { parseIntent } from "../router/intent-parser.js";

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
  spawnAgent?(projectId: string, agent: import("../types/agent.js").Agent): Promise<void>;
}

/** Interface for dynamically creating and removing agents */
export interface AgentFactory {
  createAgent(projectId: string, agentId: string, repo: string, orgId?: string): Promise<void>;
}

// ── In-memory rate limiter (sliding window) ─────────────────────────
const rateLimits = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(key: string, limit: number, windowMs: number): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  const entry = rateLimits.get(key);

  if (!entry || now > entry.resetAt) {
    rateLimits.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterMs: 0 };
  }

  entry.count++;
  if (entry.count <= limit) {
    return { allowed: true, retryAfterMs: 0 };
  }

  return { allowed: false, retryAfterMs: Math.ceil((entry.resetAt - now) / 1000) };
}

// Clean up expired rate limit entries every 5 minutes
const rateLimitCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimits) {
    if (now > entry.resetAt) rateLimits.delete(key);
  }
}, 300_000);
// Allow the process to exit without waiting for the cleanup timer
if (typeof rateLimitCleanupInterval === "object" && "unref" in rateLimitCleanupInterval) {
  rateLimitCleanupInterval.unref();
}

// ── GitHub webhook signature verification ────────────────────────────
function verifyGitHubSignature(payload: string, signature: string, secret: string): boolean {
  const expected = "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

// ── Resend welcome email ──────────────────────────────────────────
async function sendWelcomeEmail(email: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return; // Skip if not configured

  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM_EMAIL || "CodeSpar <dispatch@codespar.dev>",
        to: email,
        subject: "Welcome to Dispatch",
        html: `<p>You're subscribed to Dispatch, the CodeSpar engineering blog.</p><p>Architecture decisions, agent design patterns, and engineering lessons. One post per week.</p><p>Read the latest: <a href="https://codespar.dev/blog">codespar.dev/blog</a></p><p>— Fabiano</p>`,
      }),
    });
    newsletterLog.info("Welcome email sent", { email });
  } catch (err) {
    newsletterLog.error("Failed to send welcome email", { email, error: err instanceof Error ? err.message : String(err) });
  }
}

// ── Server-Sent Events (SSE) ─────────────────────────────────────
const sseConnections = new Set<{ reply: FastifyReply; orgId: string }>();

/**
 * Broadcast an event to all connected SSE clients.
 * If orgId is provided, only clients matching that org (or "default") receive it.
 */
export function broadcastEvent(event: { type: string; data: unknown }, orgId?: string): void {
  for (const conn of sseConnections) {
    if (orgId && conn.orgId !== orgId && conn.orgId !== "default") continue;
    try {
      conn.reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      sseConnections.delete(conn);
    }
  }
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
  private vectorStore: VectorStore | null = null;
  private storageBaseDir: string = ".codespar";
  private orgStorageCache: Map<string, StorageProvider> = new Map();
  private chatHandler: ((message: import("../types/normalized-message.js").NormalizedMessage, orgId?: string) => Promise<import("../types/channel-adapter.js").ChannelResponse | null>) | null = null;
  private alertHandler: ((message: string, type: string) => Promise<void>) | null = null;
  private _vercelDedup: Map<string, number> = new Map();

  constructor(config?: WebhookServerConfig) {
    this.port = config?.port ?? parseInt(process.env["PORT"] ?? "3000", 10);
    this.host = config?.host ?? "0.0.0.0";
    this.startedAt = new Date();

    this.app = Fastify({ logger: false });
    this.app.register(cors, { origin: true });
    this.registerRequestTracking();
    this.registerVersionHeader();
    this.registerRateLimiting();
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

  /** Set the vector store for memory stats endpoint */
  setVectorStore(store: VectorStore): void {
    this.vectorStore = store;
  }

  /** Set a handler for broadcasting deploy alerts to connected channels */
  setAlertHandler(handler: (message: string, type: string) => Promise<void>): void {
    this.alertHandler = handler;
  }

  /** Set a handler for web chat messages routed through the message router */
  setChatHandler(handler: (message: import("../types/normalized-message.js").NormalizedMessage, orgId?: string) => Promise<import("../types/channel-adapter.js").ChannelResponse | null>): void {
    this.chatHandler = handler;
  }

  /** Set the base directory used for org-scoped file storage */
  setStorageBaseDir(baseDir: string): void {
    this.storageBaseDir = baseDir;
  }

  /**
   * Get org ID from the x-org-id header, falling back to "default".
   * When orgId is "default", the root (legacy) storage is used.
   */
  private getOrgId(request: { headers: Record<string, string | string[] | undefined> }): string {
    return (request.headers["x-org-id"] as string) || "default";
  }

  /**
   * Get a StorageProvider scoped to the given org.
   * Returns the root storage provider for "default" org (backward compatible).
   * Creates org-scoped FileStorage instances for named orgs, cached per orgId.
   */
  private getOrgStorage(orgId: string): StorageProvider {
    if (orgId === "default" && this.storageProvider) {
      return this.storageProvider;
    }

    let storage = this.orgStorageCache.get(orgId);
    if (!storage) {
      storage = new FileStorage(this.storageBaseDir, orgId);
      this.orgStorageCache.set(orgId, storage);
    }
    return storage;
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
    log.info("Listening", { host: this.host, port: this.port });
  }

  /** Graceful shutdown */
  async stop(): Promise<void> {
    await this.app.close();
    log.info("Stopped");
  }

  /** Add API version header to all responses */
  private registerVersionHeader(): void {
    this.app.addHook("onSend", async (_request, reply) => {
      reply.header("X-API-Version", "v1");
    });
  }

  /** Track request count and latency via metrics hooks */
  private registerRequestTracking(): void {
    this.app.addHook("onRequest", async (request) => {
      // Stash start time for latency calculation
      (request as unknown as Record<string, unknown>).__startTime = Date.now();
      metrics.increment("api.requests");
    });

    this.app.addHook("onResponse", async (request) => {
      const start = (request as unknown as Record<string, unknown>).__startTime;
      if (typeof start === "number") {
        metrics.observe("api.latency_ms", Date.now() - start);
      }
    });
  }

  /** Register rate limiting as a Fastify onRequest hook */
  private registerRateLimiting(): void {
    const WINDOW_MS = 60_000; // 1 minute

    this.app.addHook("onRequest", async (request, reply) => {
      const url = request.url;

      // Skip rate limiting for health endpoint
      if (url === "/health" || url === "/v1/health") return;

      const ip = request.ip;
      let limit: number;
      let keyPrefix: string;

      if (url.startsWith("/webhooks/") || url.startsWith("/v1/webhooks/")) {
        limit = 30;
        keyPrefix = "webhook";
      } else if (url.startsWith("/api/") || url.startsWith("/v1/api/")) {
        limit = 100;
        keyPrefix = "api";
      } else {
        // Unknown routes are not rate limited
        return;
      }

      const key = `${keyPrefix}:${ip}`;
      const { allowed, retryAfterMs } = checkRateLimit(key, limit, WINDOW_MS);

      if (!allowed) {
        reply.header("Retry-After", String(retryAfterMs));
        return reply.status(429).send({
          error: "Too Many Requests",
          retryAfter: retryAfterMs,
        });
      }
    });
  }

  private registerRoutes(): void {
    // Helper: register a route on both the original path and under /v1/ prefix.
    // This keeps backward compatibility while enabling versioned endpoints.
    // Future breaking changes go in /v2/.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const route = (method: "get" | "post" | "delete", path: string, handler: any) => {
      this.app[method](path, handler);
      this.app[method](`/v1${path}`, handler);
    };

    // Health check
    route("get", "/health", async (_request: any, _reply: any) => {
      const uptimeMs = Date.now() - this.startedAt.getTime();
      return {
        status: "ok",
        agents: this.agentCount,
        uptime: uptimeMs,
      };
    });

    // SSE endpoint for real-time updates
    route("get", "/api/events", async (request: any, reply: any) => {
      const orgId = (request.headers["x-org-id"] as string) || "default";

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });

      const connection = { reply, orgId };
      sseConnections.add(connection);

      // Send initial ping
      reply.raw.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

      // Heartbeat every 30s
      const heartbeat = setInterval(() => {
        reply.raw.write(`: heartbeat\n\n`);
      }, 30000);

      // Clean up on disconnect
      request.raw.on("close", () => {
        clearInterval(heartbeat);
        sseConnections.delete(connection);
      });
    });

    // Metrics endpoint
    route("get", "/api/metrics", async (_request: any, _reply: any) => {
      const uptimeMs = Date.now() - this.startedAt.getTime();
      return {
        uptime: uptimeMs,
        agents: this.agentCount,
        metrics: metrics.toJSON(),
      };
    });

    // ── Web Chat endpoint ─────────────────────────────────────────
    route("post", "/api/chat", async (request: any, reply: any) => {
      const body = request.body as {
        text?: string;
        agentId?: string;
        imageUrls?: Array<{ url: string; mimeType?: string }>;
      };
      const text = String(body.text || "").trim();
      if (!text) {
        reply.code(400).send({ error: "Message text is required" });
        return;
      }

      const orgId = this.getOrgId(request);
      const agentId = body.agentId || "agent-default";

      // Build a normalized message from the web chat request
      const message: NormalizedMessage = {
        id: randomUUID(),
        channelType: "web",
        channelId: `web-${orgId}`,
        channelUserId: `web-user-${orgId}`,
        isDM: true,
        isMentioningBot: true,
        text,
        timestamp: new Date(),
        attachments: body.imageUrls?.map((img) => ({
          type: "image" as const,
          url: img.url,
          mimeType: img.mimeType,
        })),
      };

      const intent = await parseIntent(text);

      let responseText = `[${agentId}] No agent available to handle this message.`;

      try {
        if (this.chatHandler) {
          const response = await this.chatHandler(message, orgId);
          responseText = response?.text || responseText;
        }
      } catch (err) {
        responseText = `Error: ${err instanceof Error ? err.message : "Unknown error"}`;
      }

      // Audit log
      const storage = this.getOrgStorage(orgId);
      if (storage) {
        try {
          await storage.appendAudit({
            actorType: "user",
            actorId: message.channelUserId,
            action: intent.type === "unknown" ? "chat.message" : `${intent.type}.executed`,
            result: "success",
            metadata: {
              agentId,
              channel: "web",
              detail: text.slice(0, 100),
              orgId,
            },
          });
        } catch {
          // Audit logging is best-effort
        }
      }

      reply.send({
        text: responseText,
        intent: intent.type,
        confidence: intent.confidence,
        timestamp: new Date().toISOString(),
      });
    });

    // ── Streaming Web Chat endpoint (SSE) ─────────────────────────
    route("post", "/api/chat/stream", async (request: any, reply: any) => {
      const body = request.body as {
        text?: string;
        imageUrls?: Array<{ url: string; mimeType?: string }>;
      };
      const text = String(body.text || "").trim();
      if (!text) {
        reply.code(400).send({ error: "Message text is required" });
        return;
      }

      const orgId = this.getOrgId(request);

      // Set SSE headers (disable buffering for real-time streaming)
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "X-Accel-Buffering": "no", // Disable nginx/proxy buffering
      });
      // Disable Node.js socket buffering for immediate delivery
      reply.raw.socket?.setNoDelay(true);

      // Send progress events as the agent works
      function sendEvent(type: string, data: unknown) {
        reply.raw.write(
          `data: ${JSON.stringify({ type, ...(data as object) })}\n\n`
        );
        // Force flush
        if (typeof (reply.raw as any).flush === "function") {
          (reply.raw as any).flush();
        }
      }

      sendEvent("progress", { message: "Parsing command..." });

      // Parse intent
      const intent = await parseIntent(text);

      sendEvent("progress", {
        message: `Understood: ${intent.type} (${(intent.confidence * 100).toFixed(0)}% confidence)`,
      });

      // Build normalized message with progress callback in metadata
      const message: NormalizedMessage = {
        id: randomUUID(),
        channelType: "web" as ChannelType,
        channelId: `web-${orgId}`,
        channelUserId: `web-user-${orgId}`,
        isDM: true,
        isMentioningBot: true,
        text,
        timestamp: new Date(),
        attachments: body.imageUrls?.map((img) => ({
          type: "image" as const,
          url: img.url,
          mimeType: img.mimeType,
        })),
        metadata: {
          onProgress: (event: unknown) => {
            const e = event as Record<string, unknown>;
            // Wrap the progress event, preserving message and code fields
            // but setting type to "progress" so the frontend handles it
            sendEvent("progress", { message: e.message, code: e.code });
          },
        },
      };

      // Send intent-specific progress messages
      if (intent.type === "instruct" || intent.type === "fix") {
        sendEvent("progress", {
          message: "Searching codebase for relevant files...",
        });
      } else if (intent.type === "review") {
        sendEvent("progress", {
          message: "Fetching PR data from GitHub...",
        });
      } else if (intent.type === "lens") {
        sendEvent("progress", {
          message: "Analyzing your data question...",
        });
      } else if (intent.type === "plan") {
        sendEvent("progress", {
          message: "Breaking down the feature into tasks...",
        });
      }

      try {
        let responseText = "No agent available.";
        if (this.chatHandler) {
          const response = await this.chatHandler(message, orgId);
          responseText = response?.text || responseText;
        }

        // Send the final response
        sendEvent("response", { text: responseText, intent: intent.type });
      } catch (err) {
        sendEvent("error", {
          message: err instanceof Error ? err.message : "Unknown error",
        });
      }

      // Close the stream
      sendEvent("done", {});
      reply.raw.end();
    });

    // ── Dashboard API endpoints ──────────────────────────────────

    // System status overview
    route("get", "/api/status", async (_request: any, _reply: any) => {
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


    // List all registered agent types (built-in + custom plugins)
    route("get", "/api/agent-types", async (_request: any, _reply: any) => {
      return { types: getRegisteredTypes() };
    });

    // List all agents with status (filtered by org)
    route("get", "/api/agents", async (request: any, _reply: any) => {
      const orgId = this.getOrgId(request);
      const statuses = this.agentSupervisor?.getAgentStatuses() ?? [];

      // Filter agents by org
      const filtered = orgId === "default"
        ? statuses // Default org sees all agents without orgId (backward compatible)
        : statuses.filter((s) => {
            // Include agents for this org, plus agents with no org (shared/default)
            const agentOrgId = s.orgId || "default";
            return agentOrgId === orgId || agentOrgId === "default";
          });

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

        if (!this.agentSupervisor) {
          return reply.status(500).send({ error: "Supervisor not configured" });
        }

        // Check for duplicate name
        const existingStatuses = this.agentSupervisor.getAgentStatuses();
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
          const agent = factory(agentConfig, this.storageProvider ?? undefined);
          const spawnProjectId = projectId ?? name;

          if (!this.agentSupervisor.spawnAgent) {
            return reply.status(501).send({ error: "Supervisor does not support spawning agents" });
          }

          await this.agentSupervisor.spawnAgent(spawnProjectId, agent);

          // Audit trail
          if (this.storageProvider) {
            await this.storageProvider.appendAudit({
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

        if (!this.agentSupervisor) {
          return reply.status(500).send({ error: "Supervisor not configured" });
        }

        // Verify agent exists
        const statuses = this.agentSupervisor.getAgentStatuses();
        const agent = statuses.find((s) => s.id === id);
        if (!agent) {
          return reply.status(404).send({ error: "Agent not found" });
        }

        // Remove via supervisor (uses projectId, which may differ from agent id)
        const projectId = agent.projectId ?? id;
        if (!this.agentSupervisor.removeAgent) {
          return reply.status(501).send({ error: "Supervisor does not support removing agents" });
        }

        const removed = await this.agentSupervisor.removeAgent(projectId);
        if (!removed) {
          return reply.status(500).send({ error: `Failed to remove agent '${id}'` });
        }

        // Audit trail
        if (this.storageProvider) {
          await this.storageProvider.appendAudit({
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
        if (!this.storageProvider) {
          return { linked: false, config: null };
        }

        const agentId = request.query.agentId ?? "";
        if (!agentId) {
          return { linked: false, config: null, error: "agentId query param required" };
        }

        const orgId = this.getOrgId(request);

        // Verify the agent belongs to this org
        if (orgId !== "default") {
          const orgStorage = this.getOrgStorage(orgId);
          const orgProjects = await orgStorage.getProjectsList();
          const belongsToOrg = orgProjects.some((p) => p.agentId === agentId);
          if (!belongsToOrg) {
            reply.code(404).send({ error: "Agent not found in this organization" });
            return;
          }
        }

        const config = await this.storageProvider.getProjectConfig(agentId);
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

    // Create a new project (spawns a new Project Agent, org-scoped)
    route("post", "/api/projects",
      async (request: any, reply: any) => {
        const { repo, name } = request.body as { repo?: string; name?: string };

        if (!repo || !repo.includes("/")) {
          return reply.status(400).send({ error: "repo is required in 'owner/repo' format" });
        }

        const orgId = this.getOrgId(request);
        const storage = this.getOrgStorage(orgId);

        if (!this.agentFactory) {
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
          await this.agentFactory.createAgent(projectId, agentId, repo, orgId);
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
      const orgId = this.getOrgId(request);
      const storage = this.getOrgStorage(orgId);

      const projects = await storage.getProjectsList();
      return { projects };
    });

    // Remove a project (shuts down its agent, org-scoped)
    route("delete", "/api/projects/:id",
      async (request: any, reply: any) => {
        const { id } = request.params;
        const orgId = this.getOrgId(request);
        const storage = this.getOrgStorage(orgId);

        const projects = await storage.getProjectsList();
        const project = projects.find((p) => p.id === id);

        if (!project) {
          return reply.status(404).send({ error: `Project '${id}' not found` });
        }

        // Shut down the agent via the supervisor
        if (this.agentSupervisor?.removeAgent) {
          await this.agentSupervisor.removeAgent(id);
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

        if (!this.agentSupervisor) {
          return reply.status(500).send({ error: "Supervisor not configured" });
        }

        const statuses = this.agentSupervisor.getAgentStatuses();
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
          if (this.storageProvider) {
            await this.storageProvider.setMemory(id, "autonomyLevel", level);
            await this.storageProvider.saveAgentState(id, {
              agentId: id,
              state: "active",
              autonomyLevel: level,
              updatedAt: new Date().toISOString(),
            });
            await this.storageProvider.appendAudit({
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
          if (this.agentSupervisor.restartAgent) {
            const ok = await this.agentSupervisor.restartAgent(id);
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

        if (this.storageProvider) {
          // Persist agent state so it survives restart
          const currentLevel = (agentStatus as unknown as Record<string, unknown>).autonomyLevel as number ?? 1;
          await this.storageProvider.saveAgentState(id, {
            agentId: id,
            state: action === "suspend" ? "suspended" : "active",
            autonomyLevel: currentLevel,
            updatedAt: new Date().toISOString(),
          });
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

        broadcastEvent({ type: "agent.status", data: { id, status: newState } });

        return { success: true, action, agentId: id, newState };
      }
    );

    // ── Memory stats (vector store) ──
    route("get", "/api/memory", async (_request: any, _reply: any) => {
      if (!this.vectorStore) {
        return { total: 0, byCategory: {} };
      }
      return this.vectorStore.getStats();
    });

    // ── Identity lookup (by channel type + channel user ID) ──
    route("get", "/api/identity",
      async (request: any, _reply: any) => {
        const channelType = request.query.channelType as ChannelType | undefined;
        const channelUserId = request.query.channelUserId;

        if (!channelType || !channelUserId || !this.identityStore) {
          return null;
        }

        const identity = this.identityStore.resolve(channelType, channelUserId);
        if (!identity) return null;

        return {
          displayName: identity.displayName,
          role: identity.role,
          channels: Array.from(identity.channelIdentities.entries()).map(
            ([type, id]) => ({ type, id }),
          ),
        };
      }
    );

    // ── List connected channels ──
    route("get", "/api/channels", async (request: any, _reply: any) => {
      const orgId = this.getOrgId(request);
      const adapters = this.agentSupervisor?.getAdapters?.() ?? [];

      // Build global adapter status from health checks
      const globalChannels = await Promise.all(
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

      // If no adapters are registered, build from env vars
      if (globalChannels.length === 0) {
        for (const name of ["whatsapp", "slack", "telegram", "discord"] as const) {
          const envKey = `ENABLE_${name.toUpperCase()}`;
          globalChannels.push({
            name,
            platform: name,
            connected: process.env[envKey] === "true",
            capabilities: null as unknown as ReturnType<ChannelAdapter["getCapabilities"]>,
          });
        }
      }

      // For the default org, global adapter/env status is sufficient
      if (orgId === "default") {
        return { channels: globalChannels };
      }

      // For non-default orgs, check org-specific channel installations.
      // A channel is only "connected" for this org if it has a stored
      // config (via saveChannelConfig) or a Slack installation.
      const orgStorage = this.getOrgStorage(orgId);
      const orgChannels = await Promise.all(
        globalChannels.map(async (ch) => {
          let orgConnected = false;

          try {
            // Check org-specific channel config first
            const config = await orgStorage.getChannelConfig(ch.platform);
            if (config) {
              orgConnected = true;
            }

            // For Slack, also check org-specific Slack installations
            if (!orgConnected && ch.platform === "slack") {
              const installations = await orgStorage.getAllSlackInstallations();
              orgConnected = installations.length > 0;
            }
          } catch {
            // Storage read failed; treat as not connected
          }

          return {
            ...ch,
            connected: orgConnected,
          };
        })
      );

      return { channels: orgChannels };
    });

    // ── Reconnect a channel (placeholder) ──
    route("post", "/api/channels/:name/reconnect",
      async (request: any, reply: any) => {
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

    // ── Channel configure (store credentials for onboarding) ──
    route("post", "/api/channels/configure",
      async (request: any, reply: any) => {
        const { channel, config } = request.body as {
          channel?: string;
          config?: Record<string, string>;
        };

        const validChannels = ["telegram", "whatsapp", "discord", "slack", "vercel", "github"];
        if (!channel || !validChannels.includes(channel)) {
          return reply.status(400).send({
            error: `channel must be one of: ${validChannels.join(", ")}`,
          });
        }

        if (!config || typeof config !== "object" || Object.keys(config).length === 0) {
          return reply.status(400).send({
            error: "config must be a non-empty object with string values",
          });
        }

        // Validate that all config values are strings
        for (const [key, value] of Object.entries(config)) {
          if (typeof value !== "string") {
            return reply.status(400).send({
              error: `config.${key} must be a string`,
            });
          }
        }

        const orgId = this.getOrgId(request);
        const storage = this.getOrgStorage(orgId);

        if (!storage) {
          return reply.status(500).send({ error: "Storage not configured" });
        }

        await storage.saveChannelConfig(channel, config);

        // Log to audit trail
        await storage.appendAudit({
          actorType: "user",
          actorId: "dashboard",
          action: "channel.configure",
          result: "success",
          metadata: {
            channel,
            configKeys: Object.keys(config),
            detail: `Channel ${channel} configured via dashboard`,
          },
        });

        log.info("Channel configured", { channel, configKeys: Object.keys(config) });

        return { success: true, channel, configured: true };
      }
    );

    // ── Approval vote ──
    route("post", "/api/approval/vote",
      async (request: any, reply: any) => {
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

          broadcastEvent({
            type: "audit.new",
            data: { action: "approval.voted", vote, status: result.status },
          });
        }

        return { success: true, result };
      }
    );

    // List audit entries (org-scoped via x-org-id header, paginated)
    route("get", "/api/audit",
      async (request: any, _reply: any) => {
        const rawLimit = parseInt(request.query.limit ?? "20", 10);
        const pageSize = Math.min(Math.max(rawLimit, 1), 100);
        const pageNum = Math.max(parseInt(request.query.page ?? "1", 10), 1);
        const riskFilter = request.query.risk ?? "all";
        const orgId = this.getOrgId(request);
        const storage = this.getOrgStorage(orgId);

        // Fetch all entries (unfiltered by risk) so we can apply risk filter on the full set
        // We request a large limit to get all entries for risk filtering
        const { entries: allEntries, total: unfilteredTotal } = await storage.queryAudit("", 10000, 0);

        const filtered =
          riskFilter === "all"
            ? allEntries
            : allEntries.filter(
                (e) =>
                  e.metadata?.["risk"] === riskFilter
              );

        const total = filtered.length;
        const totalPages = Math.max(Math.ceil(total / pageSize), 1);
        const offset = (pageNum - 1) * pageSize;
        const page = filtered.slice(offset, offset + pageSize);

        return {
          entries: page.map((e) => {
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
              classifiedBy: e.metadata?.["classifiedBy"] ?? undefined,
              confidence: e.metadata?.["confidence"] ?? undefined,
              commitSha: e.metadata?.["commitSha"] ?? "",
              commitAuthor: e.metadata?.["commitAuthor"] ?? "",
              commitMessage: e.metadata?.["commitMessage"] ?? "",
              branch: e.metadata?.["branch"] ?? "",
              errorMessage: e.metadata?.["errorMessage"] ?? "",
              inspectorUrl: e.metadata?.["inspectorUrl"] ?? "",
              prId: e.metadata?.["prId"] ?? "",
              url: e.metadata?.["url"] ?? "",
              repo: e.metadata?.["repo"] ?? "",
              source: e.metadata?.["source"] ?? "",
            };
          }),
          total,
          page: pageNum,
          pageSize,
          totalPages,
          hasMore: pageNum < totalPages,
        };
      }
    );

    // ── Organization management ──────────────────────────────────

    // Create a new organization (creates directory structure)
    route("post", "/api/orgs",
      async (request: any, reply: any) => {
        const { id, name } = request.body as { id?: string; name?: string };

        if (!id) {
          return reply.status(400).send({ error: "id is required" });
        }

        // Initialize the org storage (creates directory on first write)
        const storage = this.getOrgStorage(id);
        // Write an empty projects list to initialize the org directory
        await storage.addProject({ id: "__init__", agentId: "__init__", repo: "__init__" });
        await storage.removeProject("__init__");

        return {
          id,
          name: name ?? id,
          createdAt: new Date().toISOString(),
        };
      }
    );

    // List organizations (scan orgs directory)
    route("get", "/api/orgs", async (_request: any, _reply: any) => {
      const orgsDir = path.resolve(this.storageBaseDir, "orgs");
      try {
        const entries = await fs.readdir(orgsDir, { withFileTypes: true });
        const orgs = entries
          .filter((e) => e.isDirectory())
          .map((e) => ({ id: e.name, name: e.name }));
        return { orgs };
      } catch {
        return { orgs: [] };
      }
    });

    // Get organization details
    route("get", "/api/orgs/:id",
      async (request: any, _reply: any) => {
        const { id } = request.params;
        const storage = this.getOrgStorage(id);

        const projects = await storage.getProjectsList();

        return {
          id,
          name: id,
          projects,
        };
      }
    );

    // ── Newsletter endpoints ──────────────────────────────────────

    // Subscribe to newsletter
    route("post", "/api/newsletter/subscribe",
      async (request: any, reply: any) => {
        const { email, source } = request.body as { email?: string; source?: string };

        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return reply.status(400).send({ error: "Valid email is required" });
        }

        const storage = this.storageProvider ?? this.getOrgStorage("default");

        // Check if already subscribed before adding
        const existing = (await storage.getSubscribers()).find(
          (s) => s.email === email.trim().toLowerCase()
        );

        const subscriber = await storage.addSubscriber(email, source ?? "homepage");

        if (existing) {
          return { success: true, message: "Already subscribed" };
        }

        // Send welcome email for new subscribers
        await sendWelcomeEmail(subscriber.email);

        return { success: true, message: "Subscribed" };
      }
    );

    // List all subscribers (admin endpoint)
    route("get", "/api/newsletter/subscribers", async (_request: any, _reply: any) => {
      const storage = this.storageProvider ?? this.getOrgStorage("default");
      const subscribers = await storage.getSubscribers();
      return { subscribers, count: subscribers.length };
    });

    // Unsubscribe
    route("delete", "/api/newsletter/unsubscribe",
      async (request: any, reply: any) => {
        const { email } = request.body as { email?: string };

        if (!email) {
          return reply.status(400).send({ error: "email is required" });
        }

        const storage = this.storageProvider ?? this.getOrgStorage("default");
        await storage.removeSubscriber(email);

        return { success: true };
      }
    );

    // Public subscriber count
    route("get", "/api/newsletter/count", async (_request: any, _reply: any) => {
      const storage = this.storageProvider ?? this.getOrgStorage("default");
      const count = await storage.getSubscriberCount();
      return { count };
    });

    // ── Scheduler endpoints ──────────────────────────────────────

    // List all scheduled tasks
    route("get", "/api/scheduler", async (_request: any, _reply: any) => {
      const tasks = scheduler.getTasks().map((t) => ({
        id: t.id,
        name: t.name,
        intervalMs: t.intervalMs,
        lastRun: t.lastRun?.toISOString() ?? null,
        nextRun: t.nextRun?.toISOString() ?? null,
        runCount: t.runCount,
        errors: t.errors,
        enabled: t.enabled,
      }));
      return { tasks };
    });

    // Pause a scheduled task
    route("post", "/api/scheduler/:name/pause",
      async (request: any, reply: any) => {
        const { name } = request.params;
        const ok = scheduler.pause(name);
        if (!ok) {
          return reply.status(404).send({ error: `Task '${name}' not found` });
        }
        return { success: true };
      }
    );

    // Resume a scheduled task
    route("post", "/api/scheduler/:name/resume",
      async (request: any, reply: any) => {
        const { name } = request.params;
        const ok = scheduler.resume(name);
        if (!ok) {
          return reply.status(404).send({ error: `Task '${name}' not found` });
        }
        return { success: true };
      }
    );

    // Cancel a scheduled task
    route("delete", "/api/scheduler/:name",
      async (request: any, reply: any) => {
        const { name } = request.params;
        const ok = scheduler.cancel(name);
        if (!ok) {
          return reply.status(404).send({ error: `Task '${name}' not found` });
        }
        return { success: true };
      }
    );

    // ── Slack OAuth 2.0 ─────────────────────────────────────────────

    const SLACK_OAUTH_SCOPES = "app_mentions:read,chat:write,channels:read,files:read,users:read";

    // Initiate Slack OAuth flow by redirecting to the Slack authorization page
    route("get", "/api/slack/install", async (request: any, reply: any) => {
      const clientId = process.env.SLACK_CLIENT_ID;
      if (!clientId) {
        return reply.status(500).send({ error: "SLACK_CLIENT_ID is not configured" });
      }

      // Accept orgId from query param (browser redirects can't send custom headers)
      const orgId = (request.query as Record<string, string>)?.orgId || this.getOrgId(request);
      const redirectUri = process.env.SLACK_OAUTH_REDIRECT_URI || "";
      const params = new URLSearchParams({
        client_id: clientId,
        scope: SLACK_OAUTH_SCOPES,
        redirect_uri: redirectUri,
        state: orgId, // Pass orgId so callback knows which org to save to
      });

      const authorizeUrl = `https://slack.com/oauth/v2/authorize?${params.toString()}`;
      return reply.redirect(authorizeUrl);
    });

    // Handle OAuth callback from Slack, exchange code for bot token, and save installation
    route("get", "/api/slack/callback", async (request: any, reply: any) => {
      const { code, error: oauthError, state } = request.query as { code?: string; error?: string; state?: string };
      const orgId = state || "default";

      if (oauthError) {
        log.warn("Slack OAuth denied", { error: oauthError });
        return reply.redirect("/?slack=error&reason=denied");
      }

      if (!code) {
        return reply.status(400).send({ error: "Missing authorization code" });
      }

      const clientId = process.env.SLACK_CLIENT_ID;
      const clientSecret = process.env.SLACK_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        return reply.status(500).send({ error: "Slack OAuth credentials are not configured" });
      }

      try {
        const tokenRes = await fetch("https://slack.com/api/oauth.v2.access", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            code,
            redirect_uri: process.env.SLACK_OAUTH_REDIRECT_URI || "",
          }),
        });

        const tokenData = await tokenRes.json() as {
          ok: boolean;
          error?: string;
          team?: { id: string; name: string };
          bot_user_id?: string;
          app_id?: string;
          access_token?: string;
          authed_user?: { id: string };
          scope?: string;
        };

        if (!tokenData.ok) {
          log.error("Slack token exchange failed", { error: tokenData.error });
          return reply.redirect("/?slack=error&reason=token_exchange");
        }

        const installation: SlackInstallation = {
          teamId: tokenData.team?.id ?? "",
          teamName: tokenData.team?.name ?? "",
          botToken: tokenData.access_token ?? "",
          botUserId: tokenData.bot_user_id ?? "",
          appId: tokenData.app_id ?? "",
          installedBy: tokenData.authed_user?.id ?? "",
          installedAt: new Date().toISOString(),
          scopes: tokenData.scope?.split(",") ?? [],
        };

        // Save to org-scoped storage so the channels endpoint shows "connected" for this org
        const installStorage = orgId !== "default"
          ? this.getOrgStorage(orgId)
          : (this.storageProvider ?? new FileStorage(this.storageBaseDir));
        await installStorage.saveSlackInstallation(installation);

        // Also save to default storage for the Slack adapter to find the token
        if (orgId !== "default") {
          const defaultStorage = this.storageProvider ?? new FileStorage(this.storageBaseDir);
          await defaultStorage.saveSlackInstallation(installation);
        }

        log.info("Slack installation saved", { teamId: installation.teamId, teamName: installation.teamName, orgId });
        const dashboardUrl = process.env.DASHBOARD_URL || "https://codespar.dev";
        return reply.redirect(`${dashboardUrl}/dashboard/setup?slack=connected`);
      } catch (err) {
        log.error("Slack OAuth callback error", { error: err instanceof Error ? err.message : String(err) });
        const dashboardUrl = process.env.DASHBOARD_URL || "https://codespar.dev";
        return reply.redirect(`${dashboardUrl}/dashboard/setup?slack=error`);
      }
    });

    // List all Slack installations (admin endpoint)
    route("get", "/api/slack/installations", async (_request: any, _reply: any) => {
      const storage = this.storageProvider ?? new FileStorage(this.storageBaseDir);
      const installations = await storage.getAllSlackInstallations();
      return { installations };
    });

    // ── Discord install (multi-tenant bot invite) ─────────────────────
    // Discord bots are inherently multi-tenant: one bot token works across
    // all servers. This endpoint redirects to the Discord authorize URL so
    // users can add the bot to their server.
    route("get", "/api/discord/install", async (_request: any, reply: any) => {
      const clientId = process.env.DISCORD_CLIENT_ID;
      if (!clientId) {
        return reply.status(503).send({ error: "Discord not configured. Set DISCORD_CLIENT_ID." });
      }

      // Permissions bitfield:
      //   Send Messages (2048) + Read Message History (65536)
      //   + Attach Files (32768) + Use Slash Commands (2147483648)
      const permissions = "2147581952";
      const scope = "bot";
      const redirectUrl = `https://discord.com/api/oauth2/authorize?client_id=${encodeURIComponent(clientId)}&permissions=${permissions}&scope=${scope}`;
      return reply.redirect(redirectUrl);
    });

    // ── GitHub OAuth (per-workspace) ──────────────────────────────────

    // Initiate GitHub OAuth flow by redirecting to the authorization page
    route("get", "/api/github/install", async (_request: any, reply: any) => {
      const clientId = process.env.GITHUB_CLIENT_ID;
      if (!clientId) {
        return reply.status(503).send({ error: "GitHub OAuth not configured. Set GITHUB_CLIENT_ID." });
      }

      const redirectUri =
        process.env.GITHUB_OAUTH_REDIRECT_URI ||
        `${process.env.WEBHOOK_BASE_URL || "https://codespar-production.up.railway.app"}/api/github/callback`;
      const scope = "repo,read:user";
      const state = Math.random().toString(36).slice(2, 10);
      const url = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}&state=${state}`;
      return reply.redirect(url);
    });

    // Handle OAuth callback from GitHub, exchange code for access token, and save per-org
    route("get", "/api/github/callback", async (request: any, reply: any) => {
      const { code } = request.query as { code?: string };
      if (!code) {
        return reply.status(400).send({ error: "Missing code parameter" });
      }

      const clientId = process.env.GITHUB_CLIENT_ID;
      const clientSecret = process.env.GITHUB_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        return reply.status(503).send({ error: "GitHub OAuth not configured" });
      }

      try {
        const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            client_id: clientId,
            client_secret: clientSecret,
            code,
          }),
        });

        if (!tokenRes.ok) {
          log.error("GitHub token exchange HTTP error", { status: tokenRes.status });
          return reply.status(500).send({ error: "Failed to exchange code for token" });
        }

        const tokenData = (await tokenRes.json()) as {
          access_token?: string;
          token_type?: string;
          scope?: string;
          error?: string;
        };

        if (!tokenData.access_token) {
          log.error("GitHub token exchange failed", { error: tokenData.error });
          return reply.status(400).send({ error: tokenData.error || "No access token received" });
        }

        // Get GitHub user info
        const userRes = await fetch("https://api.github.com/user", {
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
            Accept: "application/vnd.github.v3+json",
          },
        });
        const userData = (await userRes.json()) as { login?: string; id?: number; name?: string };

        // Save the GitHub installation per org
        const orgId = this.getOrgId(request);
        const storage = this.getOrgStorage(orgId);

        await storage.setMemory("github-oauth", "token", tokenData.access_token);
        await storage.setMemory("github-oauth", "user", userData.login || "unknown");
        await storage.setMemory("github-oauth", "scope", tokenData.scope || "");
        await storage.setMemory("github-oauth", "connectedAt", new Date().toISOString());

        await storage.appendAudit({
          actorType: "user",
          actorId: userData.login || "unknown",
          action: "github.connected",
          result: "success",
          metadata: {
            orgId,
            githubUser: userData.login,
            scope: tokenData.scope,
          },
        });

        log.info("GitHub OAuth connected", { orgId, user: userData.login });

        const dashboardUrl = process.env.DASHBOARD_URL || "https://codespar.dev";
        return reply.redirect(`${dashboardUrl}/dashboard/setup?github=connected`);
      } catch (err) {
        log.error("GitHub OAuth callback error", { error: err instanceof Error ? err.message : String(err) });
        const dashboardUrl = process.env.DASHBOARD_URL || "https://codespar.dev";
        return reply.redirect(`${dashboardUrl}/dashboard/setup?github=error`);
      }
    });

    // Check if GitHub is connected for the current org
    route("get", "/api/github/status", async (request: any, _reply: any) => {
      const orgId = this.getOrgId(request);
      const storage = this.getOrgStorage(orgId);

      const token = await storage.getMemory("github-oauth", "token");
      const user = await storage.getMemory("github-oauth", "user");
      const connectedAt = await storage.getMemory("github-oauth", "connectedAt");

      return {
        connected: !!token,
        user: (user as string) || null,
        connectedAt: (connectedAt as string) || null,
      };
    });

    // GitHub webhook receiver
    route("post", "/webhooks/github", async (request: any, reply: any) => {
      metrics.increment("webhook.received");
      const orgId = (request.query as Record<string, string>).orgId || (request.headers["x-org-id"] as string) || "default";
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        if (typeof value === "string") {
          headers[key.toLowerCase()] = value;
        }
      }

      // Verify GitHub webhook signature when secret is configured.
      // Priority: org storage secret > env GITHUB_WEBHOOK_SECRET_<ORGID> > env GITHUB_WEBHOOK_SECRET.
      let webhookSecret: string | undefined;
      if (this.storageProvider && orgId !== "default") {
        try {
          const orgStorage = this.getOrgStorage(orgId);
          const ghConfig = await orgStorage.getChannelConfig("github");
          if (ghConfig?.webhookSecret) {
            webhookSecret = ghConfig.webhookSecret;
          }
        } catch (err) {
          log.warn("Failed to load org GitHub webhook secret, using env fallback", { orgId, error: String(err) });
        }
      }
      if (!webhookSecret) {
        const orgSpecificSecret = orgId !== "default"
          ? process.env[`GITHUB_WEBHOOK_SECRET_${orgId.toUpperCase().replace(/-/g, "_")}`]
          : undefined;
        webhookSecret = orgSpecificSecret || process.env["GITHUB_WEBHOOK_SECRET"];
      }
      if (webhookSecret) {
        const signature = headers["x-hub-signature-256"];
        if (!signature) {
          return reply.status(401).send({ error: "Missing x-hub-signature-256 header" });
        }

        const rawBody = typeof request.body === "string"
          ? request.body
          : JSON.stringify(request.body);

        if (!verifyGitHubSignature(rawBody, signature, webhookSecret)) {
          return reply.status(401).send({ error: "Invalid webhook signature" });
        }
      } else {
        log.warn("GITHUB_WEBHOOK_SECRET is not set — skipping signature verification");
      }

      const event = parseGitHubWebhook(headers, request.body);

      if (!event) {
        return reply.status(200).send({ received: true, processed: false });
      }

      // Skip intermediate workflow_run states -- only log the final result
      // (a single push generates queued, in_progress, and completed events)
      if (event.type === "workflow_run" && (event.status === "in_progress" || event.status === "queued")) {
        return reply.status(200).send({ received: true, processed: false, reason: "intermediate_state" });
      }

      // Log to audit with org-scoped storage
      const ghStorage = this.getOrgStorage(orgId);
      await ghStorage.appendAudit({
        actorType: "system",
        actorId: "github",
        action: `ci.${event.type}`,
        result: event.status === "failure" ? "error" : event.status === "success" ? "success" : "pending",
        metadata: {
          repo: event.repo,
          branch: event.branch,
          title: event.details.title,
          sha: event.details.sha,
          detail: `${event.repo}: ${event.details.title || event.type}${event.branch ? ` (${event.branch})` : ""}`,
          source: "github",
          orgId,
        },
      });

      // Broadcast to SSE clients scoped to org
      broadcastEvent({
        type: "ci.event",
        data: { repo: event.repo, type: event.type, status: event.status, branch: event.branch, orgId },
      }, orgId);

      // Dispatch to all registered handlers
      const errors: Error[] = [];
      for (const handler of this.eventHandlers) {
        try {
          await handler(event);
        } catch (err) {
          const error =
            err instanceof Error ? err : new Error(String(err));
          errors.push(error);
          log.error("Handler error", { error: error.message });
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

    // ── Vercel deploy webhook ──────────────────────────────────────
    route("post", "/webhooks/vercel", async (request: any, reply: any) => {
      const orgId = (request.query as Record<string, string>).orgId || (request.headers["x-org-id"] as string) || "default";

      // Verify Vercel webhook signature if secret is configured.
      // Prefer org-specific secret from storage, fall back to env var.
      let vercelSecret = process.env.VERCEL_WEBHOOK_SECRET;
      if (this.storageProvider && orgId !== "default") {
        try {
          const orgStorage = this.getOrgStorage(orgId);
          const vercelConfig = await orgStorage.getChannelConfig("vercel");
          if (vercelConfig?.webhookSecret) {
            vercelSecret = vercelConfig.webhookSecret;
          }
        } catch (err) {
          log.warn("Failed to load org Vercel webhook secret, using global", { orgId, error: String(err) });
        }
      }
      if (vercelSecret) {
        const signature = request.headers["x-vercel-signature"] as string;
        if (!signature) {
          reply.code(401).send({ error: "Missing x-vercel-signature header" });
          return;
        }
        const rawBody = typeof request.body === "string"
          ? request.body
          : JSON.stringify(request.body);
        const expected = createHmac("sha1", vercelSecret).update(rawBody).digest("hex");
        if (signature !== expected) {
          log.warn("Vercel signature mismatch");
          reply.code(401).send({ error: "Invalid signature" });
          return;
        }
      }

      const payload = request.body as Record<string, unknown>;

      // Vercel sends different event types
      // Docs: https://vercel.com/docs/webhooks
      const type = String(payload.type || ""); // "deployment.created", "deployment.succeeded", "deployment.error", "deployment.canceled"
      const innerPayload = (payload.payload as Record<string, unknown>) || payload;

      // Vercel nests deployment data under payload.deployment or directly in payload
      const deployment = (innerPayload.deployment as Record<string, unknown>) || innerPayload;

      log.info("Vercel webhook received", { type, project: name, state, deploymentId, hasMeta: !!meta });

      const name = String(
        innerPayload.name ||
        deployment.name ||
        (innerPayload.project as Record<string, unknown> | undefined)?.name ||
        (deployment.project as Record<string, unknown> | undefined)?.name ||
        "unknown"
      );
      const url = String(innerPayload.url || deployment.url || "");
      const state = String(deployment.state || deployment.readyState || type.split(".")[1] || "unknown");
      const meta = (deployment.meta || innerPayload.meta) as Record<string, unknown> | undefined;
      const commitMessage = String(meta?.githubCommitMessage || meta?.gitlabCommitMessage || "");
      const branch = String(meta?.githubCommitRef || meta?.gitlabCommitRef || "main");
      const commitSha = String(meta?.githubCommitSha || meta?.gitlabCommitSha || "").slice(0, 7);
      const commitAuthor = String(meta?.githubCommitAuthorName || meta?.gitlabCommitAuthorName || "");
      const prId = String(meta?.githubPrId || "");
      const githubOrg = String(meta?.githubCommitOrg || meta?.githubOrg || "");
      const githubRepo = String(meta?.githubCommitRepo || meta?.githubRepo || "");
      const errorMessage = String(deployment.errorMessage || deployment.buildError || (deployment as any).errorStep || innerPayload.errorMessage || "");
      const inspectorUrl = String(deployment.inspectorUrl || innerPayload.inspectorUrl || "");

      const deploymentId = String(deployment.id || deployment.uid || "");
      log.info("Vercel webhook event", { type, project: name, state, deploymentId });

      // Skip intermediate deploy states
      if (type === "deployment.created" || state === "BUILDING" || state === "INITIALIZING" || state === "QUEUED") {
        return reply.send({ received: true, processed: false, reason: "intermediate_state" });
      }

      // Dedup: two layers — in-memory (fast) + audit log (survives restarts)
      // In-memory check
      if (!this._vercelDedup) this._vercelDedup = new Map();
      const dedupKey = `${deploymentId || name}-${state}`;
      const DEDUP_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
      const lastSeen = this._vercelDedup.get(dedupKey);
      if (lastSeen && Date.now() - lastSeen < DEDUP_WINDOW_MS) {
        return reply.send({ received: true, processed: false, reason: "duplicate" });
      }

      const vercelStorage = this.getOrgStorage(orgId);
      const isError = state === "ERROR" || state === "error";
      const isSuccess = state === "READY" || state === "succeeded";

      // Persistent dedup: check recent audit entries for same project+state+commit
      try {
        const { entries: recent } = await vercelStorage.queryAudit("", 50, 0);
        const fiveMinAgo = new Date(Date.now() - DEDUP_WINDOW_MS);
        const isDup = recent.some((e) => {
          if (e.timestamp < fiveMinAgo) return false;
          if (e.actorId !== "vercel") return false;
          const m = e.metadata as Record<string, unknown> | undefined;
          // Match by deploymentId if available, otherwise by project+state+commitSha
          if (deploymentId && m?.["deploymentId"] === deploymentId && e.action === `deploy.${state}`) return true;
          if (m?.["project"] === name && e.action === `deploy.${state}` && commitSha && m?.["commitSha"] === commitSha) return true;
          return false;
        });
        if (isDup) {
          this._vercelDedup.set(dedupKey, Date.now());
          return reply.send({ received: true, processed: false, reason: "duplicate_persistent" });
        }
      } catch (err) {
        log.warn("Dedup audit check failed, proceeding", { error: String(err) });
      }

      // Record in memory dedup
      this._vercelDedup.set(dedupKey, Date.now());
      // Evict stale entries
      if (this._vercelDedup.size > 200) {
        const now = Date.now();
        for (const [id, ts] of this._vercelDedup) {
          if (now - ts > DEDUP_WINDOW_MS) this._vercelDedup.delete(id);
        }
      }

      await vercelStorage.appendAudit({
        actorType: "system",
        actorId: "vercel",
        action: `deploy.${state}`,
        result: isError ? "error" : isSuccess ? "success" : "pending",
        metadata: {
          project: name,
          url,
          branch,
          commitSha,
          commitAuthor,
          prId,
          inspectorUrl,
          commitMessage: commitMessage.slice(0, 200),
          errorMessage: errorMessage.slice(0, 500),
          risk: isError ? "medium" : "low",
          detail: (() => {
            const parts: string[] = [name];

            if (isSuccess) {
              parts.push("deployed");
              if (branch && branch !== "main") parts.push(branch);
              if (commitMessage) parts.push(`"${commitMessage.slice(0, 60)}"`);
              if (commitSha) parts.push(`(${commitSha})`);
              if (commitAuthor) parts.push(`by ${commitAuthor}`);
              return parts.join(" ");
            }
            if (isError) {
              parts.push("· Build failed");
              if (branch) parts.push(`on ${branch}`);
              if (commitSha) parts.push(`(${commitSha})`);
              if (commitAuthor) parts.push(`by ${commitAuthor}`);
              if (errorMessage) parts.push(`· ${errorMessage.slice(0, 150)}`);
              return parts.join(" ");
            }
            return `${name} deploying ${branch || ""}`.trim();
          })(),
          deploymentId,
          repo: githubOrg && githubRepo ? `${githubOrg}/${githubRepo}` : "",
          source: "vercel",
          orgId,
        },
      });

      // Broadcast to SSE clients scoped to org
      broadcastEvent({
        type: "deploy.status",
        data: { project: name, state, url, error: errorMessage || undefined, orgId },
      }, orgId);

      // For failures, notify connected channels
      if (state === "ERROR" || state === "error" || type === "deployment.error") {
        const alertMessage = [
          `Deploy failed: ${name}`,
          `  Branch: ${branch}`,
          commitMessage ? `  Commit: ${commitMessage.slice(0, 80)}` : "",
          errorMessage ? `  Error: ${errorMessage.slice(0, 200)}` : "",
          url ? `  URL: https://${url}` : "",
        ].filter(Boolean).join("\n");

        if (this.alertHandler) {
          await this.alertHandler(alertMessage, "deploy-failure");
        }
      }

      // For successes, also notify (shorter message)
      if (state === "READY" || state === "succeeded" || type === "deployment.succeeded") {
        const successMessage = [
          `Deploy succeeded: ${name}`,
          commitMessage ? `  ${commitMessage.slice(0, 80)}` : "",
          url ? `  https://${url}` : "",
        ].filter(Boolean).join("\n");

        if (this.alertHandler) {
          await this.alertHandler(successMessage, "deploy-success");
        }
      }

      reply.send({ received: true, type, state });
    });

    // ── Generic deploy webhook ─────────────────────────────────────
    route("post", "/webhooks/deploy", async (request: any, reply: any) => {
      const orgId = (request.query as Record<string, string>).orgId || (request.headers["x-org-id"] as string) || "default";
      const body = request.body as {
        project?: string;
        status: "success" | "failure" | "pending";
        message?: string;
        url?: string;
        error?: string;
        source?: string;
      };

      const project = body.project || "unknown";
      const status = body.status || "pending";
      const source = body.source || "generic";

      log.info("Deploy webhook event", { project, status, source });

      const deployStorage = this.getOrgStorage(orgId);
      await deployStorage.appendAudit({
        actorType: "system",
        actorId: source,
        action: `deploy.${status}`,
        result: status === "failure" ? "error" : status === "success" ? "success" : "pending",
        metadata: {
          project,
          url: body.url,
          error: body.error,
          message: body.message,
          detail:
            status === "success"
              ? `${project}: deployed${body.url ? ` (${body.url})` : ""}`
              : status === "failure"
                ? `${project}: ${body.error || "deploy failed"}`
                : `${project}: deploying${body.message ? ` - ${body.message.slice(0, 60)}` : ""}`,
          source,
          orgId,
        },
      });

      broadcastEvent({ type: "deploy.status", data: { project, status, source, orgId } }, orgId);

      if (status === "failure" && this.alertHandler) {
        const alert = [
          `Deploy failed: ${project}`,
          body.error ? `  Error: ${body.error.slice(0, 200)}` : "",
          body.message ? `  ${body.message.slice(0, 100)}` : "",
          body.url ? `  ${body.url}` : "",
        ].filter(Boolean).join("\n");
        await this.alertHandler(alert, "deploy-failure");
      }

      if (status === "success" && this.alertHandler) {
        await this.alertHandler(
          `Deploy succeeded: ${project}${body.url ? ` (${body.url})` : ""}`,
          "deploy-success",
        );
      }

      reply.send({ received: true, status });
    });

    // ── Webhook URL generator (org-scoped) ────────────────────────
    route("get", "/api/webhooks/status", async (request: any, reply: any) => {
      const orgId = this.getOrgId(request);
      const orgStorage = this.getOrgStorage(orgId);

      // Check which services have secrets configured
      const vercelConfig = await orgStorage.getChannelConfig("vercel");
      const githubConfig = await orgStorage.getChannelConfig("github");

      reply.send({
        vercel: { secretConfigured: !!vercelConfig?.webhookSecret },
        github: { secretConfigured: !!githubConfig?.webhookSecret },
      });
    });

    route("get", "/api/webhooks/url", async (request: any, reply: any) => {
      const orgId = (request.headers["x-org-id"] as string) || "default";
      const baseUrl = process.env.WEBHOOK_BASE_URL || "https://codespar-production.up.railway.app";

      reply.send({
        vercel: `${baseUrl}/webhooks/vercel?orgId=${orgId}`,
        github: `${baseUrl}/webhooks/github?orgId=${orgId}`,
        deploy: `${baseUrl}/webhooks/deploy?orgId=${orgId}`,
        instructions: {
          vercel: "Add this URL in Vercel > Settings > Webhooks. Select: Deployment Created, Succeeded, Error.",
          github: "Add this URL in GitHub > Repo > Settings > Webhooks. Select: push, pull_request, workflow_run.",
          deploy: "POST to this URL with { project, status, message, error, url, source }.",
        },
      });
    });
  }
}
