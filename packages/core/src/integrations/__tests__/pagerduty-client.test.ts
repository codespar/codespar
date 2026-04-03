/**
 * Tests for PagerDutyClient — mocks fetch for all API calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PagerDutyClient, PagerDutyClientError } from "../pagerduty-client.js";
import type { PagerDutyConfig } from "../pagerduty-client.js";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: new Headers(),
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as unknown as Response;
}

const defaultConfig: PagerDutyConfig = {
  apiToken: "test-pd-token",
  fromEmail: "alerts@example.com",
  serviceId: "PSVC001",
  escalationPolicyId: "PEPOL001",
};

describe("PagerDutyClient", () => {
  let client: PagerDutyClient;

  beforeEach(() => {
    client = new PagerDutyClient(defaultConfig, 5000);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── createIncident ─────────────────────────────────────────────────

  describe("createIncident", () => {
    it("creates an incident with default service and escalation policy", async () => {
      const pdResponse = {
        incident: {
          id: "P1234AB",
          title: "Deploy failure: api-gateway (main)",
          status: "triggered",
          urgency: "high",
          service: { id: "PSVC001", summary: "API Gateway" },
          assignments: [
            { assignee: { id: "PUSER01", summary: "Alice Smith", email: "alice@example.com" } },
          ],
          created_at: "2026-04-02T14:30:00Z",
          html_url: "https://myteam.pagerduty.com/incidents/P1234AB",
        },
      };

      mockFetch.mockResolvedValueOnce(jsonResponse(pdResponse));

      const incident = await client.createIncident({
        title: "Deploy failure: api-gateway (main)",
        body: "Root cause: missing env variable",
        urgency: "high",
      });

      expect(incident.id).toBe("P1234AB");
      expect(incident.title).toBe("Deploy failure: api-gateway (main)");
      expect(incident.status).toBe("triggered");
      expect(incident.urgency).toBe("high");
      expect(incident.service.id).toBe("PSVC001");
      expect(incident.service.name).toBe("API Gateway");
      expect(incident.assignedTo).toHaveLength(1);
      expect(incident.assignedTo[0].name).toBe("Alice Smith");
      expect(incident.htmlUrl).toBe("https://myteam.pagerduty.com/incidents/P1234AB");

      // Verify request
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.pagerduty.com/incidents");
      expect(opts.method).toBe("POST");

      const body = JSON.parse(opts.body);
      expect(body.incident.title).toBe("Deploy failure: api-gateway (main)");
      expect(body.incident.service.id).toBe("PSVC001");
      expect(body.incident.urgency).toBe("high");
      expect(body.incident.body.details).toBe("Root cause: missing env variable");
      expect(body.incident.escalation_policy.id).toBe("PEPOL001");

      // Verify auth header format
      expect(opts.headers.Authorization).toBe("Token token=test-pd-token");
      expect(opts.headers.From).toBe("alerts@example.com");
    });

    it("uses override serviceId when provided", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        incident: {
          id: "P5678",
          title: "Test",
          status: "triggered",
          urgency: "low",
          service: { id: "PSVC002", summary: "Web Frontend" },
          assignments: [],
          created_at: "2026-04-02T15:00:00Z",
          html_url: "https://myteam.pagerduty.com/incidents/P5678",
        },
      }));

      await client.createIncident({
        title: "Test",
        serviceId: "PSVC002",
        urgency: "low",
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.incident.service.id).toBe("PSVC002");
      expect(body.incident.urgency).toBe("low");
    });

    it("throws when no serviceId is available", async () => {
      const clientNoService = new PagerDutyClient({
        apiToken: "tok",
        fromEmail: "a@b.com",
      });

      await expect(
        clientNoService.createIncident({ title: "Test" }),
      ).rejects.toThrow(PagerDutyClientError);
      await expect(
        clientNoService.createIncident({ title: "Test" }),
      ).rejects.toThrow("No serviceId");
    });

    it("omits body when not provided", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        incident: {
          id: "P9999",
          title: "Simple",
          status: "triggered",
          urgency: "high",
          service: { id: "PSVC001", summary: "API" },
          assignments: [],
          created_at: "2026-04-02T16:00:00Z",
          html_url: "https://myteam.pagerduty.com/incidents/P9999",
        },
      }));

      await client.createIncident({ title: "Simple" });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.incident.body).toBeUndefined();
    });
  });

  // ── getOnCall ──────────────────────────────────────────────────────

  describe("getOnCall", () => {
    it("fetches and parses on-call users", async () => {
      const pdResponse = {
        oncalls: [
          {
            escalation_level: 1,
            user: { id: "PUSER01", name: "Alice Smith", email: "alice@example.com" },
          },
          {
            escalation_level: 2,
            user: { id: "PUSER02", name: "Bob Jones", email: "bob@example.com" },
          },
        ],
      };

      mockFetch.mockResolvedValueOnce(jsonResponse(pdResponse));

      const oncall = await client.getOnCall();

      expect(oncall).toHaveLength(2);
      expect(oncall[0].id).toBe("PUSER01");
      expect(oncall[0].name).toBe("Alice Smith");
      expect(oncall[0].email).toBe("alice@example.com");
      expect(oncall[0].escalationLevel).toBe(1);
      expect(oncall[1].escalationLevel).toBe(2);

      // Verify escalation policy ID in query
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("escalation_policy_ids[]=PEPOL001");
    });

    it("uses explicit escalation policy and schedule IDs", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ oncalls: [] }));

      await client.getOnCall({
        escalationPolicyId: "PEPOL999",
        scheduleId: "PSCHED01",
      });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("escalation_policy_ids[]=PEPOL999");
      expect(url).toContain("schedule_ids[]=PSCHED01");
    });

    it("handles empty on-call response", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ oncalls: [] }));

      const oncall = await client.getOnCall();

      expect(oncall).toEqual([]);
    });
  });

  // ── acknowledgeIncident ────────────────────────────────────────────

  describe("acknowledgeIncident", () => {
    it("acknowledges an incident successfully", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ incidents: [{ id: "P1234", status: "acknowledged" }] }));

      const result = await client.acknowledgeIncident("P1234");

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.pagerduty.com/incidents");
      expect(opts.method).toBe("PUT");

      const body = JSON.parse(opts.body);
      expect(body.incidents[0].id).toBe("P1234");
      expect(body.incidents[0].status).toBe("acknowledged");
    });

    it("returns false on API error", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ error: { message: "Not found" } }, 404));

      const result = await client.acknowledgeIncident("PNOTFOUND");

      expect(result).toBe(false);
    });
  });

  // ── resolveIncident ────────────────────────────────────────────────

  describe("resolveIncident", () => {
    it("resolves an incident successfully", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ incidents: [{ id: "P1234", status: "resolved" }] }));

      const result = await client.resolveIncident("P1234");

      expect(result).toBe(true);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.incidents[0].status).toBe("resolved");
    });

    it("returns false on API error", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ error: { message: "Forbidden" } }, 403));

      const result = await client.resolveIncident("P1234");

      expect(result).toBe(false);
    });
  });

  // ── listIncidents ──────────────────────────────────────────────────

  describe("listIncidents", () => {
    it("lists incidents with query parameters", async () => {
      const pdResponse = {
        incidents: [
          {
            id: "PINC001",
            title: "High CPU on web-01",
            status: "triggered",
            urgency: "high",
            service: { id: "PSVC001", summary: "Web Service" },
            assignments: [],
            created_at: "2026-04-02T10:00:00Z",
            html_url: "https://myteam.pagerduty.com/incidents/PINC001",
          },
          {
            id: "PINC002",
            title: "Deploy failure: auth-service",
            status: "acknowledged",
            urgency: "high",
            service: { id: "PSVC002", summary: "Auth Service" },
            assignments: [
              { assignee: { id: "PUSER01", summary: "Alice", email: "alice@example.com" } },
            ],
            created_at: "2026-04-02T12:00:00Z",
            html_url: "https://myteam.pagerduty.com/incidents/PINC002",
          },
        ],
      };

      mockFetch.mockResolvedValueOnce(jsonResponse(pdResponse));

      const incidents = await client.listIncidents({
        statuses: ["triggered", "acknowledged"],
        serviceIds: ["PSVC001", "PSVC002"],
        since: "2026-04-01T00:00:00Z",
        until: "2026-04-02T23:59:59Z",
        limit: 50,
      });

      expect(incidents).toHaveLength(2);
      expect(incidents[0].id).toBe("PINC001");
      expect(incidents[0].status).toBe("triggered");
      expect(incidents[1].id).toBe("PINC002");
      expect(incidents[1].assignedTo).toHaveLength(1);

      // Verify query parameters
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("statuses[]=triggered");
      expect(url).toContain("statuses[]=acknowledged");
      expect(url).toContain("service_ids[]=PSVC001");
      expect(url).toContain("service_ids[]=PSVC002");
      expect(url).toContain("limit=50");
    });

    it("handles empty incidents response", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ incidents: [] }));

      const incidents = await client.listIncidents();

      expect(incidents).toEqual([]);
    });

    it("works without parameters", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ incidents: [] }));

      await client.listIncidents();

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toBe("https://api.pagerduty.com/incidents");
    });
  });

  // ── Error handling ─────────────────────────────────────────────────

  describe("error handling", () => {
    it("throws PagerDutyClientError on 401 Unauthorized", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ error: { message: "Invalid token" } }, 401));

      try {
        await client.listIncidents();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(PagerDutyClientError);
        expect((err as PagerDutyClientError).statusCode).toBe(401);
      }
    });

    it("throws PagerDutyClientError on 429 rate limit", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ error: { message: "Rate limit exceeded" } }, 429));

      try {
        await client.getOnCall();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(PagerDutyClientError);
        expect((err as PagerDutyClientError).statusCode).toBe(429);
        expect((err as PagerDutyClientError).pdMessage).toContain("Rate limit");
      }
    });

    it("throws PagerDutyClientError on network timeout", async () => {
      const timeoutErr = new Error("The operation was aborted");
      timeoutErr.name = "TimeoutError";
      mockFetch.mockRejectedValueOnce(timeoutErr);

      try {
        await client.listIncidents();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(PagerDutyClientError);
        expect((err as PagerDutyClientError).pdMessage).toBe("timeout");
      }
    });

    it("throws PagerDutyClientError on generic network failure", async () => {
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      await expect(client.getOnCall()).rejects.toThrow(PagerDutyClientError);
    });

    it("includes response body excerpt in error message", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(
        { error: { message: "Service not found", code: 2001 } },
        404,
      ));

      try {
        await client.createIncident({ title: "Test", serviceId: "INVALID" });
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(PagerDutyClientError);
        expect((err as PagerDutyClientError).statusCode).toBe(404);
        expect((err as PagerDutyClientError).message).toContain("404");
      }
    });
  });
});
