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
import { parseGitHubWebhook, type CIEvent } from "../webhooks/github-handler.js";

export interface WebhookServerConfig {
  port?: number;
  host?: string;
}

export type CIEventHandler = (event: CIEvent) => Promise<void>;

export class WebhookServer {
  private app: FastifyInstance;
  private port: number;
  private host: string;
  private startedAt: Date;
  private eventHandlers: CIEventHandler[] = [];
  private agentCount: number = 0;

  constructor(config?: WebhookServerConfig) {
    this.port = config?.port ?? parseInt(process.env["PORT"] ?? "3000", 10);
    this.host = config?.host ?? "0.0.0.0";
    this.startedAt = new Date();

    this.app = Fastify({ logger: false });
    this.registerRoutes();
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
