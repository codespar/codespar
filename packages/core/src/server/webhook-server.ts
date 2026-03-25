/**
 * Webhook Server — Fastify HTTP server for receiving GitHub webhooks.
 *
 * Endpoints:
 * - POST /webhooks/github — receives and parses GitHub webhook payloads
 * - POST /webhooks/vercel — receives Vercel deploy event webhooks
 * - POST /webhooks/deploy — generic deploy webhook for any CI/CD service
 * - POST /webhooks/sentry — receives Sentry error/issue event webhooks
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
import { registerObservabilityRoutes } from "./routes/observability.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import { registerOAuthGitHubRoutes } from "./routes/oauth-github.js";
import type { ServerContext } from "./routes/types.js";

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

/** Structured deploy alert passed to the alert handler */
export interface DeployAlert {
  project: string;
  branch: string;
  commitSha: string;
  commitMessage: string;
  commitAuthor: string;
  errorMessage: string;
  url: string;
  repo: string;
  type: "deploy-failure" | "deploy-success";
  orgId: string;
  inspectorUrl: string;
  deploymentId: string;
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
  private alertHandler: ((alert: DeployAlert) => Promise<void>) | null = null;
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
  setAlertHandler(handler: (alert: DeployAlert) => Promise<void>): void {
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

    // Periodic health snapshots for observability (every 5 minutes)
    const SNAPSHOT_INTERVAL = 5 * 60 * 1000;
    setInterval(async () => {
      if (!this.storageProvider) return;
      const mem = process.memoryUsage();
      try {
        await this.storageProvider.appendAudit({
          actorType: "system",
          actorId: "system",
          action: "system.health_snapshot",
          result: "success",
          metadata: {
            heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
            rssMB: Math.round(mem.rss / 1024 / 1024),
            agentCount: this.agentCount,
            uptimeMs: Date.now() - this.startedAt.getTime(),
          },
        });
      } catch { /* ignore snapshot failures */ }
    }, SNAPSHOT_INTERVAL).unref();
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
      const mem = process.memoryUsage();

      // Measure event loop lag
      const lagStart = performance.now();
      await new Promise(resolve => setImmediate(resolve));
      const eventLoopLagMs = Math.round(performance.now() - lagStart);

      return {
        status: "ok",
        agents: this.agentCount,
        uptime: uptimeMs,
        memory: {
          heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
          heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
          rssMB: Math.round(mem.rss / 1024 / 1024),
        },
        eventLoopLagMs,
        activeConnections: sseConnections.size,
        nodeVersion: process.version,
      };
    });

    // SSE endpoint for real-time updates (org-scoped via query param or header)
    route("get", "/api/events", async (request: any, reply: any) => {
      const orgId = (request.query as Record<string, string>).orgId || (request.headers["x-org-id"] as string) || "default";

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

      // Filter agents by org — strict isolation, no cross-org leaking
      const filtered = orgId === "default"
        ? statuses.filter((s) => !s.orgId || s.orgId === "default")
        : statuses.filter((s) => {
            return s.orgId === orgId;
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

        // Fetch all entries then deduplicate deploy events on read.
        // This handles historical duplicates from before persistent dedup was added.
        const { entries: rawEntries } = await storage.queryAudit("", 10000, 0);

        // Deduplicate: for deploy events, keep only the latest per project+action+commitSha
        const seen = new Set<string>();
        const allEntries = rawEntries.filter((e) => {
          if (e.actorId === "vercel" && e.action.startsWith("deploy.")) {
            const m = e.metadata as Record<string, unknown> | undefined;
            const key = `${m?.["project"] || ""}-${e.action}-${m?.["commitSha"] || ""}-${m?.["branch"] || ""}`;
            if (seen.has(key)) return false;
            seen.add(key);
          }
          return true;
        });

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

    // Clear audit log for an org (admin action)
    route("delete", "/api/audit", async (request: any, reply: any) => {
      const orgId = this.getOrgId(request);
      const storage = this.getOrgStorage(orgId);
      try {
        // Overwrite audit file with empty structure
        const auditPath = path.join(this.storageBaseDir, orgId === "default" ? "" : `orgs/${orgId}`, "audit.json");
        await fs.writeFile(auditPath, JSON.stringify({ entries: [] }), "utf-8");
        log.info("Audit log cleared", { orgId });
        reply.send({ success: true, message: "Audit log cleared" });
      } catch (err) {
        log.warn("Failed to clear audit log", { orgId, error: String(err) });
        reply.code(500).send({ error: "Failed to clear audit log" });
      }
    });

    // ── Observability (extracted to routes/observability.ts) ──────
    registerObservabilityRoutes(route, this as unknown as ServerContext);


    // ── Integration token management (org-scoped) ──────────────────

    // Save integration token (org-scoped)
    route("post", "/api/integrations/configure", async (request: any, reply: any) => {
      const orgId = this.getOrgId(request);
      const storage = this.getOrgStorage(orgId);
      const { integration, config } = request.body as { integration?: string; config?: Record<string, string> };

      if (!integration || !config) {
        return reply.status(400).send({ error: "integration and config required" });
      }

      const validIntegrations = ["vercel-api", "railway-api", "sentry", "datadog"];
      if (!validIntegrations.includes(integration)) {
        return reply.status(400).send({ error: `Invalid integration: ${integration}` });
      }

      // Validate that all config values are strings
      for (const [key, value] of Object.entries(config)) {
        if (typeof value !== "string") {
          return reply.status(400).send({ error: `config.${key} must be a string` });
        }
      }

      await storage.saveChannelConfig(integration, config);

      // Log to audit trail
      await storage.appendAudit({
        actorType: "user",
        actorId: "dashboard",
        action: "integration.configure",
        result: "success",
        metadata: {
          integration,
          configKeys: Object.keys(config),
          detail: `Integration ${integration} configured via dashboard`,
        },
      });

      log.info("Integration configured", { integration, configKeys: Object.keys(config) });

      return { success: true, integration };
    });

    // Get integration status (which are configured)
    route("get", "/api/integrations/status", async (request: any, reply: any) => {
      const orgId = this.getOrgId(request);
      const storage = this.getOrgStorage(orgId);

      const integrations = ["vercel-api", "railway-api", "sentry", "datadog"];
      const status: Record<string, boolean> = {};

      for (const integration of integrations) {
        try {
          const config = await storage.getChannelConfig(integration);
          status[integration] = !!(config?.token || config?.authToken || config?.dsn || config?.apiKey);
        } catch {
          status[integration] = false;
        }
      }

      return { integrations: status };
    });

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

    // ── OAuth & GitHub (extracted to routes/oauth-github.ts) ──────
    registerOAuthGitHubRoutes(route, this as unknown as ServerContext);

    // ── Webhooks (extracted to routes/webhooks.ts) ──────
    registerWebhookRoutes(route, this as unknown as ServerContext);
  }
}
