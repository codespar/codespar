/**
 * Admin routes — integrations, orgs, newsletter, scheduler.
 */

import { createLogger } from "../../observability/logger.js";
import { scheduler } from "../../scheduler/scheduler.js";
import type { RouteFn, ServerContext } from "./types.js";
import { configureIntegrationBody, createOrgBody, subscribeBody, unsubscribeBody, parseBody } from "./schemas.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const log = createLogger("routes/admin");


const newsletterLog = createLogger("newsletter");

async function sendWelcomeEmail(email: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;
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

export function registerAdminRoutes(route: RouteFn, ctx: ServerContext): void {
    // ── Integration token management (org-scoped) ──────────────────

    // Save integration token (org-scoped)
    route("post", "/api/integrations/configure", async (request: any, reply: any) => {
      const orgId = ctx.getOrgId(request);
      const storage = ctx.getOrgStorage(orgId);
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
      const orgId = ctx.getOrgId(request);
      const storage = ctx.getOrgStorage(orgId);

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
        const storage = ctx.getOrgStorage(id);
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
      const orgsDir = path.resolve(ctx.storageBaseDir, "orgs");
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
        const storage = ctx.getOrgStorage(id);

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

        const storage = ctx.storageProvider ?? ctx.getOrgStorage("default");

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
      const storage = ctx.storageProvider ?? ctx.getOrgStorage("default");
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

        const storage = ctx.storageProvider ?? ctx.getOrgStorage("default");
        await storage.removeSubscriber(email);

        return { success: true };
      }
    );

    // Public subscriber count
    route("get", "/api/newsletter/count", async (_request: any, _reply: any) => {
      const storage = ctx.storageProvider ?? ctx.getOrgStorage("default");
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


}
