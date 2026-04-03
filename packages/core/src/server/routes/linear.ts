/**
 * Linear integration routes — list teams, list/create issues from dashboard.
 */

import { createLogger } from "../../observability/logger.js";
import { LinearClient } from "../../integrations/linear-client.js";
import type { RouteFn, ServerContext } from "./types.js";

const log = createLogger("routes/linear");

/**
 * Resolve a LinearClient from org storage config or env vars.
 * Returns null if Linear is not configured.
 */
async function resolveLinearClient(ctx: ServerContext, orgId: string): Promise<LinearClient | null> {
  // Priority 1: org storage config
  if (ctx.storageProvider && orgId !== "default") {
    try {
      const orgStorage = ctx.getOrgStorage(orgId);
      const linearConfig = await orgStorage.getChannelConfig("linear");
      if (linearConfig?.apiKey) {
        return new LinearClient({
          apiKey: linearConfig.apiKey,
          teamId: linearConfig.teamId,
        });
      }
    } catch (err) {
      log.warn("Failed to load org Linear config, using env fallback", { orgId, error: String(err) });
    }
  }

  // Priority 2: env vars
  const apiKey = process.env["LINEAR_API_KEY"];
  if (!apiKey) return null;

  return new LinearClient({
    apiKey,
    teamId: process.env["LINEAR_TEAM_ID"],
  });
}

export function registerLinearRoutes(route: RouteFn, ctx: ServerContext): void {

  // ── GET /api/integrations/linear/teams ─────────────────────────────
  route("get", "/api/integrations/linear/teams", async (request: any, reply: any) => {
    const orgId = ctx.getOrgId(request);
    const client = await resolveLinearClient(ctx, orgId);

    if (!client) {
      return reply.status(200).send({ configured: false, teams: [] });
    }

    try {
      const teams = await client.getTeams();
      reply.send({ configured: true, teams });
    } catch (err) {
      log.error("Failed to fetch Linear teams", { error: String(err) });
      reply.status(502).send({ error: "Failed to fetch teams from Linear" });
    }
  });

  // ── GET /api/integrations/linear/issues ────────────────────────────
  route("get", "/api/integrations/linear/issues", async (request: any, reply: any) => {
    const orgId = ctx.getOrgId(request);
    const client = await resolveLinearClient(ctx, orgId);

    if (!client) {
      return reply.status(200).send({ configured: false, issues: [] });
    }

    const query = request.query as Record<string, string>;
    const teamId = query.teamId;
    const stateName = query.stateName;
    const limit = query.limit ? parseInt(query.limit, 10) : 25;
    const search = query.search;

    try {
      let issues;
      if (search) {
        issues = await client.searchIssues(search, limit);
      } else {
        issues = await client.listIssues({ teamId, stateName, limit });
      }
      reply.send({ configured: true, issues });
    } catch (err) {
      log.error("Failed to fetch Linear issues", { error: String(err) });
      reply.status(502).send({ error: "Failed to fetch issues from Linear" });
    }
  });

  // ── POST /api/integrations/linear/issues ───────────────────────────
  route("post", "/api/integrations/linear/issues", async (request: any, reply: any) => {
    const orgId = ctx.getOrgId(request);
    const client = await resolveLinearClient(ctx, orgId);

    if (!client) {
      return reply.status(400).send({ error: "Linear is not configured. Set LINEAR_API_KEY or configure via org settings." });
    }

    const body = request.body as {
      title?: string;
      description?: string;
      teamId?: string;
      priority?: number;
      labelNames?: string[];
    };

    if (!body.title) {
      return reply.status(400).send({ error: "title is required" });
    }

    try {
      const issue = await client.createIssue({
        title: body.title,
        description: body.description,
        teamId: body.teamId,
        priority: body.priority,
        labelNames: body.labelNames,
      });

      log.info("Linear issue created from dashboard", { identifier: issue.identifier, title: issue.title });
      reply.status(201).send({ issue });
    } catch (err) {
      log.error("Failed to create Linear issue", { error: String(err) });
      reply.status(502).send({ error: "Failed to create issue in Linear" });
    }
  });
}
