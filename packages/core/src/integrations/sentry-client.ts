/**
 * Sentry API Client — queries Sentry for issues, events, error counts.
 *
 * Used by:
 * - Health monitor: post-deploy error rate correlation
 * - Observability proxy: dashboard Sentry panel
 * - Incident agent: root-cause investigation
 */

import { createLogger } from "../observability/logger.js";

const log = createLogger("sentry-client");

const SENTRY_API_BASE = "https://sentry.io/api/0";
const DEFAULT_TIMEOUT_MS = 10_000;

// ── Types ────────────────────────────────────────────────────────────────

export interface SentryIssue {
  id: string;
  title: string;
  culprit: string;
  level: "fatal" | "error" | "warning" | "info";
  status: "unresolved" | "resolved" | "ignored";
  count: number;
  userCount: number;
  firstSeen: string;
  lastSeen: string;
  permalink: string;
  project: { name: string; slug: string };
  shortId: string;
}

export interface SentryIssueDetail extends SentryIssue {
  annotations: string[];
  assignedTo: { type: string; name: string } | null;
  isBookmarked: boolean;
  hasSeen: boolean;
  metadata: Record<string, unknown>;
}

export interface SentryEventFrame {
  filename: string;
  lineNo: number;
  colNo: number;
  function: string;
  inApp: boolean;
  context: Array<[number, string]>;
}

export interface SentryEventException {
  type: string;
  value: string;
  stacktrace: { frames: SentryEventFrame[] } | null;
}

export interface SentryEvent {
  eventID: string;
  title: string;
  message: string;
  dateCreated: string;
  context: Record<string, unknown>;
  tags: Array<{ key: string; value: string }>;
  entries: Array<{
    type: string;
    data: {
      values?: SentryEventException[];
      [key: string]: unknown;
    };
  }>;
  user?: { id?: string; email?: string; ip_address?: string };
}

export interface SentryStatsPoint {
  timestamp: number;
  count: number;
}

export class SentryClientError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly sentryMessage?: string,
  ) {
    super(message);
    this.name = "SentryClientError";
  }
}

// ── Client ───────────────────────────────────────────────────────────────

export class SentryClient {
  private authToken: string;
  private orgSlug: string;
  private timeoutMs: number;

  constructor(authToken: string, orgSlug: string, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.authToken = authToken;
    this.orgSlug = orgSlug;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Fetch recent unresolved issues for the organization (optionally filtered by project).
   */
  async getUnresolvedIssues(projectSlug?: string, limit = 25): Promise<SentryIssue[]> {
    const projectParam = projectSlug ? `&project=${encodeURIComponent(projectSlug)}` : "";
    const url = `${SENTRY_API_BASE}/organizations/${this.orgSlug}/issues/?query=is:unresolved&sort=date${projectParam}&limit=${limit}`;

    const data = await this.request<Array<Record<string, unknown>>>(url);

    return data.map((raw) => this.mapIssue(raw));
  }

  /**
   * Fetch detailed information about a specific issue.
   */
  async getIssueDetails(issueId: string): Promise<SentryIssueDetail> {
    const url = `${SENTRY_API_BASE}/issues/${issueId}/`;
    const raw = await this.request<Record<string, unknown>>(url);

    const base = this.mapIssue(raw);
    return {
      ...base,
      annotations: (raw.annotations as string[]) || [],
      assignedTo: raw.assignedTo
        ? { type: String((raw.assignedTo as Record<string, unknown>).type || ""), name: String((raw.assignedTo as Record<string, unknown>).name || "") }
        : null,
      isBookmarked: Boolean(raw.isBookmarked),
      hasSeen: Boolean(raw.hasSeen),
      metadata: (raw.metadata as Record<string, unknown>) || {},
    };
  }

  /**
   * Fetch events (occurrences) for a specific issue — includes stack traces and breadcrumbs.
   */
  async getIssueEvents(issueId: string, limit = 10): Promise<SentryEvent[]> {
    const url = `${SENTRY_API_BASE}/issues/${issueId}/events/?limit=${limit}`;
    const data = await this.request<Array<Record<string, unknown>>>(url);

    return data.map((raw) => ({
      eventID: String(raw.eventID || ""),
      title: String(raw.title || ""),
      message: String(raw.message || ""),
      dateCreated: String(raw.dateCreated || ""),
      context: (raw.context as Record<string, unknown>) || {},
      tags: ((raw.tags || []) as Array<Record<string, string>>).map((t) => ({
        key: String(t.key || ""),
        value: String(t.value || ""),
      })),
      entries: ((raw.entries || []) as Array<Record<string, unknown>>).map((e) => ({
        type: String(e.type || ""),
        data: (e.data || {}) as SentryEvent["entries"][number]["data"],
      })),
      user: raw.user
        ? {
            id: String((raw.user as Record<string, unknown>).id || ""),
            email: String((raw.user as Record<string, unknown>).email || ""),
            ip_address: String((raw.user as Record<string, unknown>).ip_address || ""),
          }
        : undefined,
    }));
  }

  /**
   * Resolve an issue by setting its status to "resolved".
   */
  async resolveIssue(issueId: string): Promise<boolean> {
    const url = `${SENTRY_API_BASE}/issues/${issueId}/`;
    try {
      await this.request(url, {
        method: "PUT",
        body: JSON.stringify({ status: "resolved" }),
      });
      return true;
    } catch (err) {
      log.error("Failed to resolve Sentry issue", { issueId, error: String(err) });
      return false;
    }
  }

  /**
   * Get the total error count for a project since a given time.
   * Uses the project stats endpoint with a "received" outcome.
   */
  async getErrorCount(projectSlug: string, since: Date): Promise<number> {
    const sinceStr = since.toISOString();
    const untilStr = new Date().toISOString();
    // Use the outcomes stats endpoint — category "error" with "accepted" outcome
    const url = `${SENTRY_API_BASE}/organizations/${this.orgSlug}/issues/?query=is:unresolved+project:${encodeURIComponent(projectSlug)}&start=${encodeURIComponent(sinceStr)}&end=${encodeURIComponent(untilStr)}&limit=0`;

    try {
      const res = await fetch(url, {
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!res.ok) {
        // Fallback: count issues via search
        return this.countIssuesFallback(projectSlug, since);
      }

      // The X-Hits header contains the total count when limit=0
      const hits = res.headers.get("X-Hits");
      if (hits) return parseInt(hits, 10) || 0;

      // Fallback: parse response body
      return this.countIssuesFallback(projectSlug, since);
    } catch (err) {
      log.error("getErrorCount failed", { projectSlug, error: String(err) });
      return this.countIssuesFallback(projectSlug, since);
    }
  }

  // ── Internal helpers ─────────────────────────────────────────────────

  private async countIssuesFallback(projectSlug: string, since: Date): Promise<number> {
    try {
      const sinceStr = since.toISOString();
      const url = `${SENTRY_API_BASE}/organizations/${this.orgSlug}/issues/?query=is:unresolved+project:${encodeURIComponent(projectSlug)}&start=${encodeURIComponent(sinceStr)}&limit=100`;
      const data = await this.request<unknown[]>(url);
      return data.length;
    } catch {
      return 0;
    }
  }

  private getHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.authToken}`,
      "Content-Type": "application/json",
    };
  }

  private async request<T>(url: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: { ...this.getHeaders(), ...(init?.headers as Record<string, string> || {}) },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new SentryClientError("Sentry API request timed out", 0, "timeout");
      }
      throw new SentryClientError(`Sentry API request failed: ${String(err)}`, 0);
    }

    if (!res.ok) {
      let detail = "";
      try {
        const body = await res.text();
        detail = body.slice(0, 200);
      } catch { /* ignore */ }
      throw new SentryClientError(
        `Sentry API returned ${res.status}: ${detail}`,
        res.status,
        detail,
      );
    }

    return (await res.json()) as T;
  }

  private mapIssue(raw: Record<string, unknown>): SentryIssue {
    const project = (raw.project as Record<string, unknown>) || {};
    return {
      id: String(raw.id || ""),
      title: String(raw.title || ""),
      culprit: String(raw.culprit || ""),
      level: (raw.level as SentryIssue["level"]) || "error",
      status: (raw.status as SentryIssue["status"]) || "unresolved",
      count: Number(raw.count || 0),
      userCount: Number(raw.userCount || 0),
      firstSeen: String(raw.firstSeen || ""),
      lastSeen: String(raw.lastSeen || ""),
      permalink: String(raw.permalink || ""),
      project: {
        name: String(project.name || project.slug || ""),
        slug: String(project.slug || ""),
      },
      shortId: String(raw.shortId || ""),
    };
  }
}
