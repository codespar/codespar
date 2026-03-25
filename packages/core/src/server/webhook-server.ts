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
import { createStorage } from "../storage/create-storage.js";
import type { ApprovalManager } from "../approval/approval-manager.js";
import type { IdentityStore } from "../auth/identity-store.js";
import type { VectorStore } from "../memory/vector-store.js";
import type { ChannelType, NormalizedMessage } from "../types/normalized-message.js";
import { parseIntent } from "../router/intent-parser.js";
import { registerObservabilityRoutes } from "./routes/observability.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import { registerOAuthGitHubRoutes } from "./routes/oauth-github.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerChannelRoutes } from "./routes/channels.js";
import { registerApprovalAuditRoutes } from "./routes/approval-audit.js";
import { registerAdminRoutes } from "./routes/admin.js";

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
      storage = createStorage(orgId);
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


    // ── Chat (extracted to routes/chat.ts) ──────
    registerChatRoutes(route, this as unknown as ServerContext);

    // ── Agents + Projects (extracted to routes/agents.ts) ──────
    registerAgentRoutes(route, this as unknown as ServerContext);

    // ── Channels (extracted to routes/channels.ts) ──────
    registerChannelRoutes(route, this as unknown as ServerContext);

    // ── Approval + Audit (extracted to routes/approval-audit.ts) ──────
    registerApprovalAuditRoutes(route, this as unknown as ServerContext);

    // ── Observability (extracted to routes/observability.ts) ──────
    registerObservabilityRoutes(route, this as unknown as ServerContext);



    // ── Admin: integrations, orgs, newsletter, scheduler (extracted to routes/admin.ts) ──────
    registerAdminRoutes(route, this as unknown as ServerContext);

    // ── OAuth & GitHub (extracted to routes/oauth-github.ts) ──────
    registerOAuthGitHubRoutes(route, this as unknown as ServerContext);

    // ── Webhooks (extracted to routes/webhooks.ts) ──────
    registerWebhookRoutes(route, this as unknown as ServerContext);
  }
}
