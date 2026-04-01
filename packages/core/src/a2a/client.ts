/**
 * A2A Outbound Client — discover and invoke external A2A agents.
 *
 * Uses native fetch() with AbortController for timeouts.
 * Retries only on 5xx server errors.
 */

import { createLogger } from "../observability/logger.js";
import type {
  A2ATaskRequest,
  A2ATaskResponse,
  ExternalAgentCard,
} from "../types/a2a.js";

const log = createLogger("a2a/client");

export interface A2AClientOptions {
  /** Request timeout in milliseconds. Default: 30 000 ms. */
  timeout?: number;
  /** Number of retries on 5xx errors. Default: 2. */
  retries?: number;
}

type RequiredOptions = Required<A2AClientOptions>;

const DEFAULTS: RequiredOptions = {
  timeout: 30_000,
  retries: 2,
};

export class A2AClient {
  private options: RequiredOptions;

  constructor(options?: A2AClientOptions) {
    this.options = { ...DEFAULTS, ...options };
  }

  // ── Discovery ────────────────────────────────────────────────────────

  /**
   * Discover an external agent's capabilities by fetching its Agent Card
   * at `{agentUrl}/.well-known/agent.json`.
   */
  async discover(agentUrl: string): Promise<ExternalAgentCard> {
    const url = normalizeUrl(agentUrl);
    const endpoint = `${url}/.well-known/agent.json`;

    log.debug("Discovering external agent", { endpoint });

    const response = await this.fetchWithRetry(endpoint, { method: "GET" });

    if (!response.ok) {
      throw new A2AClientError(
        `Discovery failed for ${endpoint}: HTTP ${response.status}`,
        response.status,
      );
    }

    const body = (await response.json()) as Record<string, unknown>;

    const card: ExternalAgentCard = {
      url,
      name: String(body.name ?? "unknown"),
      version: body.version != null ? String(body.version) : undefined,
      protocol: body.protocol != null ? String(body.protocol) : undefined,
      agents: Array.isArray(body.agents) ? (body.agents as ExternalAgentCard["agents"]) : [],
      discoveredAt: Date.now(),
    };

    log.info("Discovered external agent", {
      url,
      name: card.name,
      agentCount: card.agents.length,
    });

    return card;
  }

  // ── Task Operations ──────────────────────────────────────────────────

  /**
   * Submit a task to an external A2A agent.
   * POSTs to `{agentUrl}/a2a/tasks`.
   */
  async submitTask(
    agentUrl: string,
    request: A2ATaskRequest,
  ): Promise<A2ATaskResponse> {
    const url = normalizeUrl(agentUrl);
    const endpoint = `${url}/a2a/tasks`;

    log.info("Submitting task to external agent", {
      endpoint,
      taskId: request.id,
      skill: request.skill,
    });

    const response = await this.fetchWithRetry(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new A2AClientError(
        `submitTask failed: HTTP ${response.status} — ${errorBody}`,
        response.status,
      );
    }

    return (await response.json()) as A2ATaskResponse;
  }

  /**
   * Poll task status from an external A2A agent.
   * GETs `{agentUrl}/a2a/tasks/{taskId}`.
   */
  async getTaskStatus(
    agentUrl: string,
    taskId: string,
  ): Promise<A2ATaskResponse> {
    const url = normalizeUrl(agentUrl);
    const endpoint = `${url}/a2a/tasks/${encodeURIComponent(taskId)}`;

    const response = await this.fetchWithRetry(endpoint, { method: "GET" });

    if (!response.ok) {
      throw new A2AClientError(
        `getTaskStatus failed for ${taskId}: HTTP ${response.status}`,
        response.status,
      );
    }

    return (await response.json()) as A2ATaskResponse;
  }

  /**
   * Cancel a remote task.
   * POSTs to `{agentUrl}/a2a/tasks/{taskId}/cancel`.
   */
  async cancelTask(
    agentUrl: string,
    taskId: string,
  ): Promise<A2ATaskResponse> {
    const url = normalizeUrl(agentUrl);
    const endpoint = `${url}/a2a/tasks/${encodeURIComponent(taskId)}/cancel`;

    const response = await this.fetchWithRetry(endpoint, { method: "POST" });

    if (!response.ok) {
      throw new A2AClientError(
        `cancelTask failed for ${taskId}: HTTP ${response.status}`,
        response.status,
      );
    }

    return (await response.json()) as A2ATaskResponse;
  }

  // ── Internal helpers ─────────────────────────────────────────────────

  /**
   * Fetch with timeout (AbortController) and retry on 5xx errors.
   */
  private async fetchWithRetry(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.options.retries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(),
          this.options.timeout,
        );

        const response = await fetch(url, {
          ...init,
          signal: controller.signal,
        });

        clearTimeout(timer);

        // Only retry on 5xx server errors
        if (response.status >= 500 && attempt < this.options.retries) {
          log.warn("Retrying after 5xx", {
            url,
            status: response.status,
            attempt: attempt + 1,
          });
          lastError = new A2AClientError(
            `Server error: HTTP ${response.status}`,
            response.status,
          );
          continue;
        }

        return response;
      } catch (err: unknown) {
        lastError = err;

        // AbortError means timeout — always retry if attempts remain
        const isAbort =
          err instanceof DOMException && err.name === "AbortError";

        if (attempt < this.options.retries) {
          log.warn("Retrying after error", {
            url,
            error: err instanceof Error ? err.message : String(err),
            isTimeout: isAbort,
            attempt: attempt + 1,
          });
          continue;
        }

        if (isAbort) {
          throw new A2AClientError(
            `Request timed out after ${this.options.timeout}ms: ${url}`,
            0,
          );
        }
      }
    }

    throw lastError;
  }
}

// ── Error class ──────────────────────────────────────────────────────

export class A2AClientError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "A2AClientError";
    this.statusCode = statusCode;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Strip trailing slash from a URL. */
function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}
