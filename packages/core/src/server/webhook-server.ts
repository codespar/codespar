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
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import cors from "@fastify/cors";
import { parseGitHubWebhook, type CIEvent } from "../webhooks/github-handler.js";
import { getRegisteredTypes, getAgentFactory, isRegisteredType, getAllAgentMetadata } from "../agents/agent-registry.js";
import { displayBaseUrl, fastifyTrustProxy } from "./base-url.js";
import { resolveApiToken } from "./api-token.js";
import {
  API_TOKEN_INVALID,
  API_TOKEN_REQUIRED,
  apiAuthError,
  candidatePaths,
  routedPath,
} from "./api-auth.js";
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
import { registerAllAgentMetadata } from "../agents/agent-metadata.js";
import { registerObservabilityRoutes } from "./routes/observability.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import { registerOAuthGitHubRoutes } from "./routes/oauth-github.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerChannelRoutes } from "./routes/channels.js";
import { registerApprovalAuditRoutes } from "./routes/approval-audit.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerA2ARoutes } from "./routes/a2a.js";
import { registerChannelRoutingRoutes } from "./routes/channel-routing.js";
import { registerPagerDutyRoutes } from "./routes/pagerduty.js";
import { registerLinearRoutes } from "./routes/linear.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { loadStartupPlugins, pluginRegistry } from "../plugins/index.js";
import { createEventBus } from "../queue/index.js";
import type { EventBus, EventBusChannel } from "../queue/event-bus.js";
import { ContainerPool } from "../execution/container-pool.js";
import { DockerSandbox } from "../execution/docker-sandbox.js";

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
  type: "deploy-failure" | "deploy-success" | "sentry-error";
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

// ── Resend welcome email ──────────────────────────────────────────
async function sendWelcomeEmail(email: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  // The sender identity and the copy belong to whoever runs this install.
  // No CodeSpar default: a self-hoster must not end up mailing their own
  // subscribers from a codespar.dev address about the CodeSpar blog.
  const from = process.env.RESEND_FROM_EMAIL?.trim();
  if (!apiKey || !from) return; // Skip if not configured

  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: email,
        subject: process.env.NEWSLETTER_SUBJECT?.trim() || "You are subscribed",
        html: `<p>You are subscribed. Reply to this email to unsubscribe.</p>`,
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
    // Send to matching org, "default" connections, OR if only 1-2 connections exist (small team = send to all)
    const isMatch = !orgId || conn.orgId === orgId || conn.orgId === "default" || sseConnections.size <= 5;
    if (!isMatch) continue;
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
  private eventBus: EventBus | null = null;
  private taskQueue: import("../queue/task-queue.js").TaskQueue | null = null;
  private storageBaseDir: string = ".codespar";
  private orgStorageCache: Map<string, StorageProvider> = new Map();
  private chatHandler: ((message: import("../types/normalized-message.js").NormalizedMessage, orgId?: string) => Promise<import("../types/channel-adapter.js").ChannelResponse | null>) | null = null;
  private alertHandler: ((alert: DeployAlert) => Promise<void>) | null = null;
  private _vercelDedup: Map<string, number> = new Map();
  private _sentryDedup: Map<string, number> = new Map();
  private _containerPool: ContainerPool | null = null;
  /**
   * Bearer token every protected route requires. Resolved once here rather
   * than read per request, so the value cannot change under a live server,
   * and materialized by api-token.ts when the operator supplied none.
   */
  readonly apiToken: string;
  private readonly _registeredRoutes: Array<{ method: string; url: string }> = [];

  constructor(config?: WebhookServerConfig) {
    this.port = config?.port ?? parseInt(process.env["PORT"] ?? "3000", 10);
    this.host = config?.host ?? "0.0.0.0";
    this.startedAt = new Date();
    this.apiToken = resolveApiToken().token;

    // trustProxy is opt-in via TRUST_PROXY. Left off, Fastify ignores
    // x-forwarded-* when computing request.ip / request.protocol / hostname,
    // which is what base-url.ts relies on: a runtime exposed directly must not
    // let a caller rewrite its own address by sending a header.
    this.app = Fastify({ logger: false, trustProxy: fastifyTrustProxy() });

    // CORS: restrict to CORS_ORIGIN when set, allow all when unset
    const corsOrigin = process.env.CORS_ORIGIN;
    if (corsOrigin) {
      const origins = corsOrigin.split(",").map(o => o.trim()).filter(Boolean);
      this.app.register(cors, { origin: origins.length === 1 ? origins[0] : origins });
    } else {
      log.warn("CORS_ORIGIN not set — allowing all origins");
      this.app.register(cors, { origin: true });
    }

    // Record what gets registered, for the route-coverage completeness test.
    this.app.addHook("onRoute", (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) {
        this._registeredRoutes.push({ method, url: route.url });
      }
    });

    registerAllAgentMetadata();
    this.registerRequestTracking();
    this.registerApiAuth();
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

  /** Expose module-level SSE connections to route modules via ServerContext */
  get sseConnections(): Set<{ reply: import("fastify").FastifyReply; orgId: string }> {
    return sseConnections;
  }

  /** Delegate to Fastify's inject() for integration testing */
  inject(opts: import("fastify").InjectOptions) {
    return this.app.inject(opts);
  }

  /**
   * The underlying Fastify instance.
   *
   * For embedders who want to listen themselves, and for tests that must go
   * over a real socket rather than through inject(). That difference matters
   * here: inject() rewrites an absolute-form request-target into origin-form
   * before any hook sees it, so the absolute-form bypass this guard now
   * defends against is not expressible through inject() at all, and a test
   * written with it would pass whether or not the defence exists.
   */
  get fastifyInstance(): FastifyInstance {
    return this.app;
  }

  /**
   * Every route this server registered, as `{ method, url }`.
   *
   * Collected from Fastify's own onRoute hook rather than from a hand-kept
   * list, so it cannot drift from what is actually served. Exists so
   * route-coverage.test.ts can assert that each route is either deliberately
   * public or refuses anonymous callers: auth here is prefix matching over a
   * flat table, so nothing stops a new route from being registered outside a
   * guarded prefix, and this is what turns that into a failing build.
   */
  get registeredRoutes(): ReadonlyArray<{ method: string; url: string }> {
    return this._registeredRoutes;
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
   * Resolve the active project id for a request. See ServerContext
   * docstring for the resolution order; mirrors the shape codespar-
   * enterprise's auth layer uses so the SDK contract is identical.
   */
  private async resolveProjectId(
    request: { headers: Record<string, string | string[] | undefined> },
    orgId: string,
  ): Promise<string> {
    const raw = request.headers["x-codespar-project"];
    const headerVal = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;

    if (headerVal) {
      // Lazy import keeps the dependency one-way (routes → helpers) and
      // avoids the helper pulling in webhook-server at module load time.
      const { PROJECT_ID_RE } = await import("../storage/project-helpers.js");
      if (!PROJECT_ID_RE.test(headerVal)) {
        throw new Error("invalid_project_header");
      }
      const storage = this.getOrgStorage(orgId);
      const project = await storage.getProject(orgId, headerVal);
      if (!project) {
        // Uniform throw — caller distinguishes cross-org from not-
        // found via the error code translation (404, not 403).
        throw new Error("project_not_found");
      }
      return project.id;
    }

    const storage = this.getOrgStorage(orgId);
    const def = await storage.getOrCreateDefaultProject(orgId);
    return def.id;
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

  /** Get the event bus instance (for external wiring, e.g. agents). */
  getEventBus(): EventBus | null {
    return this.eventBus;
  }

  /** Pre-warmed Docker container pool (null if Docker unavailable). */
  get containerPool(): ContainerPool | null {
    return this._containerPool;
  }

  /** Start listening for incoming webhooks */
  async start(): Promise<void> {
    this.startedAt = new Date();

    // Initialize the event bus (Redis Pub/Sub or in-memory fallback)
    try {
      this.eventBus = createEventBus();
      log.info("Event bus initialized");

      // Forward event bus messages to SSE clients
      const channelsToForward: EventBusChannel[] = [
        "agent:status",
        "task:created",
        "task:completed",
        "deploy:status",
        "agent:progress",
      ];
      for (const channel of channelsToForward) {
        await this.eventBus.subscribe(channel, (msg) => {
          broadcastEvent(
            { type: channel, data: msg.payload },
            msg.projectId,
          );
        });
      }
    } catch (err) {
      log.warn("Event bus initialization failed, continuing without it", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Initialize Docker container pool if Docker is available
    try {
      const probe = new DockerSandbox();
      if (await probe.isAvailable()) {
        this._containerPool = new ContainerPool();
        await this._containerPool.warmUp(2);
        log.info("Docker container pool initialized", { stats: this._containerPool.stats });
      }
    } catch (err) {
      log.warn("Docker container pool unavailable, Docker execution disabled", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Load operator-configured meta-tool plugins (CODESPAR_PLUGINS) onto the
    // global registry. Runs after the bootstrap above (so plugin register()
    // code inherits any registered hooks) and before listen() (so the catalog
    // is final before the first request). Fails closed: a bad specifier or a
    // colliding meta-tool name aborts startup rather than serving a partial set.
    const loadedPlugins = await loadStartupPlugins(pluginRegistry);
    if (loadedPlugins.length > 0) {
      log.info("Startup plugins loaded", { count: loadedPlugins.length });
    }

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
    if (this._containerPool) {
      await this._containerPool.drain();
      log.info("Docker container pool drained");
    }
    if (this.eventBus) {
      await this.eventBus.close();
      log.info("Event bus closed");
    }
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

  /**
   * Require a bearer token on every control surface. Always registered.
   *
   * This hook used to return early when ENGINE_API_TOKEN was unset, which
   * meant the documented install — `docker compose up`, with an .env.example
   * that never mentioned the variable — served `/api/*` to anyone who could
   * reach the port. There is no longer an unauthenticated mode: the
   * credential comes from api-token.ts, which mints and persists one when
   * the operator supplied none, so requiring it costs the install nothing.
   *
   * Three prefixes are protected, not one:
   *   /api      — agents, projects, channels, approvals, metrics, SSE.
   *   /sessions — creates sessions and executes tools. `server_specs` on
   *               POST /sessions is an argv that reaches child_process.spawn
   *               with this process's environment, so this is the surface
   *               where a missing check is remote code execution rather than
   *               information disclosure. It was never under the old hook,
   *               which matched `/api/` only.
   *   /a2a      — inbound agent-to-agent tasks. Had no check of any kind.
   *
   * Webhook routes are deliberately absent, because a bearer token is not a
   * scheme GitHub, Vercel or Sentry can speak; they sign instead. Say the rest
   * of it plainly, though: that signature is only VERIFIED once a secret is
   * configured, and with none configured the default is to accept the payload
   * unverified (webhook-auth.ts, WEBHOOK_STRICT_MODE, off by default). So
   * these routes are not "authenticated by signature" today, they are
   * authenticated by signature WHEN CONFIGURED. Tracked in #138, which also
   * covers why turning strict mode on today breaks the webhook this runtime
   * creates for itself. `/health` and the OAuth install/callback pair stay
   * open because the container healthcheck and a browser mid-OAuth-redirect
   * have no way to present a bearer token.
   *
   * KNOWN SHAPE PROBLEM, tracked separately: this is prefix matching over a
   * flat route table, so a route added under `/api` is protected only because
   * its path happens to start with a guarded prefix. Nothing makes a new route
   * declare its access level, which means the default for a route registered
   * somewhere else in the tree is open. The completeness test in
   * route-coverage.test.ts turns that into a failing build rather than a quiet
   * hole, and the structural fix (per-subtree encapsulated hooks, so a route
   * cannot be registered outside a guard) is the redesign this cannot safely
   * do inside an emergency patch.
   */
  private registerApiAuth(): void {
    const tokenHash = createHash("sha256").update(this.apiToken).digest();

    // Matched after stripping a leading `/v1`, because registerRoutes()
    // publishes every path twice. Guarding only the unprefixed form would
    // have left a complete second copy of the API open.
    const PROTECTED_PREFIXES = ["/api", "/sessions", "/a2a"];

    const EXCLUDED_PATHS = new Set([
      "/health", "/v1/health",
      "/.well-known/agent.json",
      "/api/slack/install", "/v1/api/slack/install",
      "/api/slack/callback", "/v1/api/slack/callback",
      "/api/discord/install", "/v1/api/discord/install",
      "/api/github/install", "/v1/api/github/install",
      "/api/github/callback", "/v1/api/github/callback",
    ]);

    const matchesProtected = (path: string): boolean => {
      const unversioned = path === "/v1" ? "/" : path.startsWith("/v1/") ? path.slice(3) : path;
      return PROTECTED_PREFIXES.some(
        (prefix) => unversioned === prefix || unversioned.startsWith(`${prefix}/`),
      );
    };

    this.app.addHook("onRequest", async (request, reply) => {
      // The guard has to decide about the SAME path the router will dispatch
      // on. Deriving that is not `request.url.split("?")[0]`: see
      // candidatePaths() in api-auth.ts for the three spellings that have each
      // been a live bypass here. `null` means the target could not be parsed,
      // which is treated as protected rather than guessed at.
      const candidates = candidatePaths(request.url);

      // Whether a route is deliberately public is a question about the handler
      // that will actually run, so it is asked of the routed path only.
      const routed = routedPath(request.url);
      if (routed !== null && EXCLUDED_PATHS.has(routed)) return;

      const isProtected = candidates === null || candidates.some(matchesProtected);
      if (!isProtected) return;

      const auth = request.headers.authorization;
      if (!auth || !auth.startsWith("Bearer ")) {
        return reply.status(401).send(apiAuthError(API_TOKEN_REQUIRED));
      }

      // Hashed before comparison so timingSafeEqual gets two buffers of the
      // same length whatever the caller sent; it throws on a length mismatch,
      // and the length itself would otherwise be an oracle.
      const providedHash = createHash("sha256").update(auth.slice(7)).digest();
      if (!timingSafeEqual(providedHash, tokenHash)) {
        return reply.status(401).send(apiAuthError(API_TOKEN_INVALID));
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

      // Key on the socket peer, never on request.ip. With trustProxy on,
      // request.ip is the leftmost x-forwarded-for hop, which is a header, so
      // a caller could rotate it per request and never reach any ceiling. The
      // socket peer is the one address the caller cannot choose. Behind a real
      // reverse proxy this collapses every client onto the proxy's address,
      // which limits harder than intended rather than not at all; per-client
      // limits belong in the proxy, which can tell clients apart safely.
      const peer = request.socket?.remoteAddress ?? "unknown";
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

      const key = `${keyPrefix}:${peer}`;
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
    const route = (method: "get" | "post" | "delete" | "patch", path: string, handler: any) => {
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

    // ── A2A Well-Known Agent Card Discovery ─────────────────────────
    this.app.get("/.well-known/agent.json", async (request, _reply) => {
      // Display-only surface: advertises this runtime's own address back to
      // the caller. Never used to write a target into a third-party system.
      const baseUrl = displayBaseUrl(request) ?? "";
      const allMetadata = getAllAgentMetadata();

      return {
        // This is how the install introduces itself to every A2A peer that
        // fetches the card. Hard-coding "CodeSpar" made each self-hoster
        // announce our name on their network; the static no-phone-home scan
        // cannot catch it because it is an identity, not a URL. Default is
        // deliberately generic, AGENT_CARD_NAME overrides it.
        name: process.env.AGENT_CARD_NAME?.trim() || "Agent Runtime",
        description:
          "Autonomous multi-agent platform for code projects. " +
          "Monitors repos, executes tasks, reviews PRs, orchestrates deploys, and investigates incidents.",
        url: baseUrl,
        version: "1.0.0",
        protocol: "a2a",
        capabilities: {
          streaming: true,
          pushNotifications: true,
        },
        agents: allMetadata.map((meta) => ({
          name: meta.displayName,
          description: meta.description,
          url: `${baseUrl}/api/agent-cards/${meta.type}`,
          version: "1.0.0",
          lifecycle: meta.lifecycle,
          capabilities: meta.capabilities,
          skills: meta.skills,
          requiredServices: meta.requiredServices,
        })),
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

    // ── Projects (environments; 2-level tenancy) ──────
    registerProjectRoutes(route, this as unknown as ServerContext);

    // ── Channels (extracted to routes/channels.ts) ──────
    registerChannelRoutes(route, this as unknown as ServerContext);

    // ── Channel Routing (per-channel alert routing rules) ──────
    registerChannelRoutingRoutes(route, this as unknown as ServerContext);

    // ── Approval + Audit (extracted to routes/approval-audit.ts) ──────
    registerApprovalAuditRoutes(route, this as unknown as ServerContext);

    // ── Observability (extracted to routes/observability.ts) ──────
    registerObservabilityRoutes(route, this as unknown as ServerContext);

    // ── A2A inbound task handling (extracted to routes/a2a.ts) ──────
    registerA2ARoutes(route, this as unknown as ServerContext);

    // ── Admin: integrations, orgs, newsletter, scheduler (extracted to routes/admin.ts) ──────
    registerAdminRoutes(route, this as unknown as ServerContext);

    // ── OAuth & GitHub (extracted to routes/oauth-github.ts) ──────
    registerOAuthGitHubRoutes(route, this as unknown as ServerContext);

    // ── PagerDuty (on-call, incidents, acknowledge) ──────
    registerPagerDutyRoutes(route, this as unknown as ServerContext);

    // ── Linear (teams, issues, auto-ticket creation) ──────
    registerLinearRoutes(route, this as unknown as ServerContext);

    // ── Session contract (SessionBase HTTP API) ──────
    registerSessionRoutes(route, this as unknown as ServerContext);

    // ── Webhooks (extracted to routes/webhooks.ts) ──────
    registerWebhookRoutes(route, this as unknown as ServerContext);
  }
}
