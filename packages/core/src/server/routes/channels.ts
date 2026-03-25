/**
 * Channel routes — list channels, reconnect, configure credentials.
 */

import { createLogger } from "../../observability/logger.js";
import type { RouteFn, ServerContext } from "./types.js";
import type { ChannelAdapter } from "../../types/channel-adapter.js";

const log = createLogger("routes/channels");

export function registerChannelRoutes(route: RouteFn, ctx: ServerContext): void {
    // ── List connected channels ──
    route("get", "/api/channels", async (request: any, _reply: any) => {
      const orgId = ctx.getOrgId(request);
      const adapters = ctx.agentSupervisor?.getAdapters?.() ?? [];

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
      const orgStorage = ctx.getOrgStorage(orgId);
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
        const adapters = ctx.agentSupervisor?.getAdapters?.() ?? [];
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

        const orgId = ctx.getOrgId(request);
        const storage = ctx.getOrgStorage(orgId);

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


}
