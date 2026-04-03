/**
 * Channel routing routes — CRUD for per-channel alert routing rules.
 *
 * Endpoints:
 *   GET    /api/channel-routes                        — list all routes
 *   POST   /api/channel-routes                        — add/update a route
 *   DELETE /api/channel-routes/:channelType/:channelId — remove a route
 */

import { ChannelRouter } from "../../routing/channel-router.js";
import type { ChannelRoute } from "../../routing/channel-router.js";
import { createLogger } from "../../observability/logger.js";
import type { RouteFn, ServerContext } from "./types.js";

const log = createLogger("routes/channel-routing");

/** Valid channel types for route configuration */
const VALID_CHANNEL_TYPES = new Set(["slack", "discord", "whatsapp", "telegram"]);

/** Valid alert types for route configuration */
const VALID_ALERT_TYPES = new Set(["deploy", "error", "incident", "all"]);

/**
 * Resolve (or create) a ChannelRouter for the given org.
 * Loads persisted routes from org storage on first access.
 */
const routerCache = new Map<string, ChannelRouter>();

async function getRouter(ctx: ServerContext, orgId: string): Promise<ChannelRouter> {
  const cached = routerCache.get(orgId);
  if (cached) return cached;

  const router = new ChannelRouter();
  const storage = ctx.getOrgStorage(orgId);
  try {
    await router.loadFromStorage(storage);
  } catch {
    // No persisted routes yet — start empty
  }
  routerCache.set(orgId, router);
  return router;
}

export function registerChannelRoutingRoutes(route: RouteFn, ctx: ServerContext): void {
  // ── List all channel routes ──
  route("get", "/api/channel-routes", async (request: any, _reply: any) => {
    const orgId = ctx.getOrgId(request);
    const router = await getRouter(ctx, orgId);
    return { routes: router.list() };
  });

  // ── Add or update a channel route ──
  route("post", "/api/channel-routes", async (request: any, reply: any) => {
    const body = request.body as Partial<ChannelRoute> | undefined;

    if (!body) {
      return reply.status(400).send({ error: "Request body is required" });
    }

    const { channelType, channelId, channelName, alertTypes, projectFilter } = body;

    // Validate channelType
    if (!channelType || !VALID_CHANNEL_TYPES.has(channelType)) {
      return reply.status(400).send({
        error: `channelType must be one of: ${[...VALID_CHANNEL_TYPES].join(", ")}`,
      });
    }

    // Validate channelId
    if (!channelId || typeof channelId !== "string" || channelId.trim() === "") {
      return reply.status(400).send({ error: "channelId is required and must be a non-empty string" });
    }

    // Validate alertTypes
    if (!alertTypes || !Array.isArray(alertTypes) || alertTypes.length === 0) {
      return reply.status(400).send({
        error: `alertTypes must be a non-empty array of: ${[...VALID_ALERT_TYPES].join(", ")}`,
      });
    }
    for (const at of alertTypes) {
      if (!VALID_ALERT_TYPES.has(at)) {
        return reply.status(400).send({
          error: `Invalid alert type "${at}". Must be one of: ${[...VALID_ALERT_TYPES].join(", ")}`,
        });
      }
    }

    // Validate projectFilter if provided
    if (projectFilter !== undefined && typeof projectFilter !== "string") {
      return reply.status(400).send({ error: "projectFilter must be a string" });
    }

    const newRoute: ChannelRoute = {
      channelType,
      channelId: channelId.trim(),
      channelName: channelName?.trim(),
      alertTypes,
      projectFilter: projectFilter?.trim() || undefined,
    };

    const orgId = ctx.getOrgId(request);
    const router = await getRouter(ctx, orgId);
    router.addRoute(newRoute);

    // Persist
    const storage = ctx.getOrgStorage(orgId);
    await router.saveToStorage(storage);

    // Audit
    await storage.appendAudit({
      actorType: "user",
      actorId: "dashboard",
      action: "channel-route.add",
      result: "success",
      metadata: {
        channelType,
        channelId: newRoute.channelId,
        alertTypes,
        projectFilter: newRoute.projectFilter,
      },
    });

    log.info("Channel route added", { channelType, channelId: newRoute.channelId, alertTypes });

    return { success: true, route: newRoute };
  });

  // ── Remove a channel route ──
  route("delete", "/api/channel-routes/:channelType/:channelId",
    async (request: any, reply: any) => {
      const { channelType, channelId } = request.params as {
        channelType: string;
        channelId: string;
      };

      if (!channelType || !channelId) {
        return reply.status(400).send({ error: "channelType and channelId are required" });
      }

      const orgId = ctx.getOrgId(request);
      const router = await getRouter(ctx, orgId);

      // Check if route exists before removing
      const existing = router.list().find(
        (r) => r.channelType === channelType && r.channelId === channelId,
      );
      if (!existing) {
        return reply.status(404).send({ error: "Route not found" });
      }

      router.removeRoute(channelType, channelId);

      // Persist
      const storage = ctx.getOrgStorage(orgId);
      await router.saveToStorage(storage);

      // Audit
      await storage.appendAudit({
        actorType: "user",
        actorId: "dashboard",
        action: "channel-route.remove",
        result: "success",
        metadata: { channelType, channelId },
      });

      log.info("Channel route removed", { channelType, channelId });

      return { success: true, removed: { channelType, channelId } };
    },
  );
}
