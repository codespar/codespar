/**
 * PagerDuty API Client — creates incidents, queries on-call, manages escalations.
 *
 * Used by:
 * - Alert handler: page on-call when critical alerts fire
 * - Dashboard: on-call roster display, incident management
 * - Health monitor: auto-resolve incidents when deploys recover
 */

import { createLogger } from "../observability/logger.js";

const log = createLogger("pagerduty-client");

const PAGERDUTY_API_BASE = "https://api.pagerduty.com";
const DEFAULT_TIMEOUT_MS = 10_000;

// ── Types ────────────────────────────────────────────────────────────────

export interface PagerDutyConfig {
  apiToken: string;              // PagerDuty API token (v2)
  serviceId?: string;            // Default service to create incidents on
  escalationPolicyId?: string;   // Default escalation policy
  fromEmail: string;             // Required by PD API for incident creation
}

export interface PagerDutyIncident {
  id: string;
  title: string;
  status: "triggered" | "acknowledged" | "resolved";
  urgency: "high" | "low";
  service: { id: string; name: string };
  assignedTo: Array<{ id: string; name: string; email: string }>;
  createdAt: string;
  htmlUrl: string;
}

export interface OnCallUser {
  id: string;
  name: string;
  email: string;
  escalationLevel: number;
}

export class PagerDutyClientError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly pdMessage?: string,
  ) {
    super(message);
    this.name = "PagerDutyClientError";
  }
}

// ── Client ───────────────────────────────────────────────────────────────

export class PagerDutyClient {
  private config: PagerDutyConfig;
  private timeoutMs: number;

  constructor(config: PagerDutyConfig, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.config = config;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Create an incident (triggers alert to on-call).
   */
  async createIncident(params: {
    title: string;
    body?: string;
    urgency?: "high" | "low";
    serviceId?: string;
  }): Promise<PagerDutyIncident> {
    const serviceId = params.serviceId || this.config.serviceId;
    if (!serviceId) {
      throw new PagerDutyClientError(
        "No serviceId provided and no default serviceId configured",
        0,
      );
    }

    const payload: Record<string, unknown> = {
      incident: {
        type: "incident",
        title: params.title,
        service: {
          id: serviceId,
          type: "service_reference",
        },
        urgency: params.urgency || "high",
        ...(params.body ? { body: { type: "incident_body", details: params.body } } : {}),
        ...(this.config.escalationPolicyId
          ? {
              escalation_policy: {
                id: this.config.escalationPolicyId,
                type: "escalation_policy_reference",
              },
            }
          : {}),
      },
    };

    const url = `${PAGERDUTY_API_BASE}/incidents`;
    const data = await this.request<Record<string, unknown>>(url, {
      method: "POST",
      body: JSON.stringify(payload),
    });

    return this.mapIncident((data.incident as Record<string, unknown>) || data);
  }

  /**
   * Get who's currently on-call for a service/escalation policy.
   */
  async getOnCall(params?: {
    escalationPolicyId?: string;
    scheduleId?: string;
  }): Promise<OnCallUser[]> {
    const queryParts: string[] = [];

    const policyId = params?.escalationPolicyId || this.config.escalationPolicyId;
    if (policyId) {
      queryParts.push(`escalation_policy_ids[]=${encodeURIComponent(policyId)}`);
    }
    if (params?.scheduleId) {
      queryParts.push(`schedule_ids[]=${encodeURIComponent(params.scheduleId)}`);
    }

    const query = queryParts.length > 0 ? `?${queryParts.join("&")}` : "";
    const url = `${PAGERDUTY_API_BASE}/oncalls${query}`;

    const data = await this.request<Record<string, unknown>>(url);
    const oncalls = (data.oncalls as Array<Record<string, unknown>>) || [];

    return oncalls.map((raw) => {
      const user = (raw.user as Record<string, unknown>) || {};
      return {
        id: String(user.id || ""),
        name: String(user.name || ""),
        email: String(user.email || ""),
        escalationLevel: Number(raw.escalation_level || 0),
      };
    });
  }

  /**
   * Acknowledge an incident.
   */
  async acknowledgeIncident(incidentId: string): Promise<boolean> {
    return this.updateIncidentStatus(incidentId, "acknowledged");
  }

  /**
   * Resolve an incident.
   */
  async resolveIncident(incidentId: string): Promise<boolean> {
    return this.updateIncidentStatus(incidentId, "resolved");
  }

  /**
   * List recent incidents.
   */
  async listIncidents(params?: {
    statuses?: string[];
    serviceIds?: string[];
    since?: string;
    until?: string;
    limit?: number;
  }): Promise<PagerDutyIncident[]> {
    const queryParts: string[] = [];

    if (params?.statuses) {
      for (const s of params.statuses) {
        queryParts.push(`statuses[]=${encodeURIComponent(s)}`);
      }
    }
    if (params?.serviceIds) {
      for (const id of params.serviceIds) {
        queryParts.push(`service_ids[]=${encodeURIComponent(id)}`);
      }
    }
    if (params?.since) {
      queryParts.push(`since=${encodeURIComponent(params.since)}`);
    }
    if (params?.until) {
      queryParts.push(`until=${encodeURIComponent(params.until)}`);
    }
    if (params?.limit) {
      queryParts.push(`limit=${params.limit}`);
    }

    const query = queryParts.length > 0 ? `?${queryParts.join("&")}` : "";
    const url = `${PAGERDUTY_API_BASE}/incidents${query}`;

    const data = await this.request<Record<string, unknown>>(url);
    const incidents = (data.incidents as Array<Record<string, unknown>>) || [];

    return incidents.map((raw) => this.mapIncident(raw));
  }

  // ── Internal helpers ─────────────────────────────────────────────────

  private async updateIncidentStatus(
    incidentId: string,
    status: "acknowledged" | "resolved",
  ): Promise<boolean> {
    const url = `${PAGERDUTY_API_BASE}/incidents`;
    try {
      await this.request(url, {
        method: "PUT",
        body: JSON.stringify({
          incidents: [
            {
              id: incidentId,
              type: "incident_reference",
              status,
            },
          ],
        }),
      });
      return true;
    } catch (err) {
      log.error(`Failed to ${status} PagerDuty incident`, {
        incidentId,
        error: String(err),
      });
      return false;
    }
  }

  private getHeaders(): Record<string, string> {
    return {
      Authorization: `Token token=${this.config.apiToken}`,
      "Content-Type": "application/json",
      From: this.config.fromEmail,
    };
  }

  private async request<T>(url: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: {
          ...this.getHeaders(),
          ...((init?.headers as Record<string, string>) || {}),
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new PagerDutyClientError("PagerDuty API request timed out", 0, "timeout");
      }
      throw new PagerDutyClientError(`PagerDuty API request failed: ${String(err)}`, 0);
    }

    if (!res.ok) {
      let detail = "";
      try {
        const body = await res.text();
        detail = body.slice(0, 200);
      } catch {
        /* ignore */
      }
      throw new PagerDutyClientError(
        `PagerDuty API returned ${res.status}: ${detail}`,
        res.status,
        detail,
      );
    }

    return (await res.json()) as T;
  }

  private mapIncident(raw: Record<string, unknown>): PagerDutyIncident {
    const service = (raw.service as Record<string, unknown>) || {};
    const assignments = (raw.assignments as Array<Record<string, unknown>>) || [];

    return {
      id: String(raw.id || ""),
      title: String(raw.title || ""),
      status: (raw.status as PagerDutyIncident["status"]) || "triggered",
      urgency: (raw.urgency as PagerDutyIncident["urgency"]) || "high",
      service: {
        id: String(service.id || ""),
        name: String(service.summary || service.name || ""),
      },
      assignedTo: assignments.map((a) => {
        const assignee = (a.assignee as Record<string, unknown>) || {};
        return {
          id: String(assignee.id || ""),
          name: String(assignee.summary || assignee.name || ""),
          email: String(assignee.email || ""),
        };
      }),
      createdAt: String(raw.created_at || ""),
      htmlUrl: String(raw.html_url || ""),
    };
  }
}
