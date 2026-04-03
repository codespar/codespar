/**
 * PagerDuty routes — on-call roster, incidents, acknowledge from dashboard.
 */

import { createLogger } from "../../observability/logger.js";
import { PagerDutyClient } from "../../integrations/pagerduty-client.js";
import type { PagerDutyConfig } from "../../integrations/pagerduty-client.js";
import type { RouteFn, ServerContext } from "./types.js";

const log = createLogger("routes/pagerduty");

/**
 * Resolve PagerDuty config from environment variables or org storage.
 * Returns null if PagerDuty is not configured.
 */
function getPagerDutyConfig(): PagerDutyConfig | null {
  const apiToken = process.env.PAGERDUTY_API_TOKEN;
  const fromEmail = process.env.PAGERDUTY_FROM_EMAIL;

  if (!apiToken || !fromEmail) return null;

  return {
    apiToken,
    fromEmail,
    serviceId: process.env.PAGERDUTY_SERVICE_ID,
    escalationPolicyId: process.env.PAGERDUTY_ESCALATION_POLICY_ID,
  };
}

export function registerPagerDutyRoutes(route: RouteFn, _ctx: ServerContext): void {
  // ── GET /api/integrations/pagerduty/oncall ─────────────────────────
  route("get", "/api/integrations/pagerduty/oncall", async (request: any, reply: any) => {
    const config = getPagerDutyConfig();
    if (!config) {
      return reply.code(404).send({
        error: "PagerDuty not configured",
        hint: "Set PAGERDUTY_API_TOKEN and PAGERDUTY_FROM_EMAIL environment variables",
      });
    }

    try {
      const client = new PagerDutyClient(config);
      const escalationPolicyId =
        (request.query as Record<string, string>).escalationPolicyId ||
        config.escalationPolicyId;
      const scheduleId = (request.query as Record<string, string>).scheduleId;

      const oncall = await client.getOnCall({
        escalationPolicyId,
        scheduleId,
      });

      return { oncall };
    } catch (err) {
      log.error("Failed to fetch PagerDuty on-call", { error: String(err) });
      return reply.code(502).send({
        error: "Failed to fetch on-call data from PagerDuty",
        detail: String(err),
      });
    }
  });

  // ── GET /api/integrations/pagerduty/incidents ──────────────────────
  route("get", "/api/integrations/pagerduty/incidents", async (request: any, reply: any) => {
    const config = getPagerDutyConfig();
    if (!config) {
      return reply.code(404).send({
        error: "PagerDuty not configured",
        hint: "Set PAGERDUTY_API_TOKEN and PAGERDUTY_FROM_EMAIL environment variables",
      });
    }

    try {
      const client = new PagerDutyClient(config);
      const query = request.query as Record<string, string>;

      const incidents = await client.listIncidents({
        statuses: query.statuses ? query.statuses.split(",") : undefined,
        serviceIds: query.serviceIds ? query.serviceIds.split(",") : undefined,
        since: query.since,
        until: query.until,
        limit: query.limit ? parseInt(query.limit, 10) : 25,
      });

      return { incidents };
    } catch (err) {
      log.error("Failed to fetch PagerDuty incidents", { error: String(err) });
      return reply.code(502).send({
        error: "Failed to fetch incidents from PagerDuty",
        detail: String(err),
      });
    }
  });

  // ── POST /api/integrations/pagerduty/incidents/:id/acknowledge ─────
  route("post", "/api/integrations/pagerduty/incidents/:id/acknowledge", async (request: any, reply: any) => {
    const config = getPagerDutyConfig();
    if (!config) {
      return reply.code(404).send({
        error: "PagerDuty not configured",
        hint: "Set PAGERDUTY_API_TOKEN and PAGERDUTY_FROM_EMAIL environment variables",
      });
    }

    const incidentId = (request.params as Record<string, string>).id;
    if (!incidentId) {
      return reply.code(400).send({ error: "Missing incident id" });
    }

    try {
      const client = new PagerDutyClient(config);
      const success = await client.acknowledgeIncident(incidentId);

      if (success) {
        return { acknowledged: true, incidentId };
      }
      return reply.code(502).send({
        error: "Failed to acknowledge incident",
        incidentId,
      });
    } catch (err) {
      log.error("Failed to acknowledge PagerDuty incident", {
        incidentId,
        error: String(err),
      });
      return reply.code(502).send({
        error: "Failed to acknowledge incident",
        detail: String(err),
      });
    }
  });
}
