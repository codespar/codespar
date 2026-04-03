/**
 * Tests for LinearClient — mocks fetch for all GraphQL calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LinearClient, LinearClientError } from "../linear-client.js";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function graphqlResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: new Headers(),
    json: async () => ({ data }),
    text: async () => JSON.stringify({ data }),
  } as unknown as Response;
}

function graphqlErrorResponse(errors: Array<{ message: string }>): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    json: async () => ({ errors }),
    text: async () => JSON.stringify({ errors }),
  } as unknown as Response;
}

function httpErrorResponse(status: number, body: string): Response {
  return {
    ok: false,
    status,
    statusText: "Error",
    headers: new Headers(),
    json: async () => ({}),
    text: async () => body,
  } as unknown as Response;
}

const SAMPLE_ISSUE = {
  id: "issue-uuid-1",
  identifier: "ENG-123",
  title: "Deploy failure on main",
  description: "Root cause: missing env var",
  url: "https://linear.app/team/issue/ENG-123",
  priority: 1,
  createdAt: "2026-04-01T10:00:00Z",
  state: { name: "Triage", type: "triage" },
  assignee: { name: "Alice", email: "alice@example.com" },
  labels: { nodes: [{ name: "incident" }, { name: "auto-created" }] },
};

describe("LinearClient", () => {
  let client: LinearClient;

  beforeEach(() => {
    client = new LinearClient({ apiKey: "lin_test_key", teamId: "team-1" }, 5000);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── createIssue ─────────────────────────────────────────────────

  describe("createIssue", () => {
    it("creates an issue and returns mapped result", async () => {
      // First call: resolve labels (team labels query)
      mockFetch.mockResolvedValueOnce(graphqlResponse({
        team: {
          labels: {
            nodes: [
              { id: "label-1", name: "incident" },
              { id: "label-2", name: "bug" },
            ],
          },
        },
      }));

      // Second call: create label "auto-created" (not found)
      mockFetch.mockResolvedValueOnce(graphqlResponse({
        issueLabelCreate: { success: true, issueLabel: { id: "label-new" } },
      }));

      // Third call: issueCreate
      mockFetch.mockResolvedValueOnce(graphqlResponse({
        issueCreate: {
          success: true,
          issue: SAMPLE_ISSUE,
        },
      }));

      const issue = await client.createIssue({
        title: "Deploy failure on main",
        description: "Root cause: missing env var",
        priority: 1,
        labelNames: ["incident", "auto-created"],
      });

      expect(issue.id).toBe("issue-uuid-1");
      expect(issue.identifier).toBe("ENG-123");
      expect(issue.title).toBe("Deploy failure on main");
      expect(issue.priority).toBe(1);
      expect(issue.state.name).toBe("Triage");
      expect(issue.assignee?.name).toBe("Alice");
      expect(issue.labels).toHaveLength(2);
      expect(issue.url).toBe("https://linear.app/team/issue/ENG-123");
    });

    it("creates an issue without labels", async () => {
      mockFetch.mockResolvedValueOnce(graphqlResponse({
        issueCreate: {
          success: true,
          issue: { ...SAMPLE_ISSUE, labels: { nodes: [] } },
        },
      }));

      const issue = await client.createIssue({
        title: "Simple issue",
      });

      expect(issue.identifier).toBe("ENG-123");
      expect(issue.labels).toHaveLength(0);
      // Only one fetch call (no label resolution)
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("throws when teamId is not provided and no default", async () => {
      const noTeamClient = new LinearClient({ apiKey: "lin_test" });

      await expect(
        noTeamClient.createIssue({ title: "Test" }),
      ).rejects.toThrow(LinearClientError);
    });

    it("throws when issueCreate returns success=false", async () => {
      mockFetch.mockResolvedValueOnce(graphqlResponse({
        issueCreate: { success: false, issue: null },
      }));

      await expect(
        client.createIssue({ title: "Bad issue" }),
      ).rejects.toThrow("success=false");
    });
  });

  // ── getTeams ──────────────────────────────────────────────────────

  describe("getTeams", () => {
    it("fetches and parses teams", async () => {
      mockFetch.mockResolvedValueOnce(graphqlResponse({
        teams: {
          nodes: [
            { id: "team-1", name: "Engineering", key: "ENG" },
            { id: "team-2", name: "Design", key: "DES" },
          ],
        },
      }));

      const teams = await client.getTeams();

      expect(teams).toHaveLength(2);
      expect(teams[0].id).toBe("team-1");
      expect(teams[0].name).toBe("Engineering");
      expect(teams[0].key).toBe("ENG");
      expect(teams[1].key).toBe("DES");
    });

    it("returns empty array when no teams", async () => {
      mockFetch.mockResolvedValueOnce(graphqlResponse({
        teams: { nodes: [] },
      }));

      const teams = await client.getTeams();
      expect(teams).toEqual([]);
    });
  });

  // ── searchIssues ──────────────────────────────────────────────────

  describe("searchIssues", () => {
    it("searches issues by query string", async () => {
      mockFetch.mockResolvedValueOnce(graphqlResponse({
        issueSearch: {
          nodes: [SAMPLE_ISSUE],
        },
      }));

      const issues = await client.searchIssues("deploy failure", 5);

      expect(issues).toHaveLength(1);
      expect(issues[0].identifier).toBe("ENG-123");

      // Verify GraphQL variables
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.variables.query).toBe("deploy failure");
      expect(body.variables.limit).toBe(5);
    });

    it("returns empty array when no results", async () => {
      mockFetch.mockResolvedValueOnce(graphqlResponse({
        issueSearch: { nodes: [] },
      }));

      const issues = await client.searchIssues("nonexistent");
      expect(issues).toEqual([]);
    });
  });

  // ── Duplicate detection logic ─────────────────────────────────────

  describe("duplicate detection (searchIssues for dedup)", () => {
    it("finds duplicate when matching title and active state exist", async () => {
      const existingIssue = {
        ...SAMPLE_ISSUE,
        title: "[CRITICAL] my-app: TypeError: Cannot read property",
        state: { name: "Backlog", type: "backlog" },
      };

      mockFetch.mockResolvedValueOnce(graphqlResponse({
        issueSearch: { nodes: [existingIssue] },
      }));

      const results = await client.searchIssues("my-app TypeError");

      // Simulate the dedup logic from start.mjs
      const duplicate = results.find(issue =>
        issue.title.includes("my-app") &&
        (issue.state.type === "backlog" || issue.state.type === "unstarted" || issue.state.type === "started")
      );

      expect(duplicate).toBeDefined();
      expect(duplicate?.identifier).toBe("ENG-123");
    });

    it("does not flag as duplicate when issue is completed", async () => {
      const completedIssue = {
        ...SAMPLE_ISSUE,
        title: "[CRITICAL] my-app: TypeError",
        state: { name: "Done", type: "completed" },
      };

      mockFetch.mockResolvedValueOnce(graphqlResponse({
        issueSearch: { nodes: [completedIssue] },
      }));

      const results = await client.searchIssues("my-app TypeError");

      const duplicate = results.find(issue =>
        issue.title.includes("my-app") &&
        (issue.state.type === "backlog" || issue.state.type === "unstarted" || issue.state.type === "started")
      );

      expect(duplicate).toBeUndefined();
    });
  });

  // ── updateIssueState ──────────────────────────────────────────────

  describe("updateIssueState", () => {
    it("updates state successfully", async () => {
      mockFetch.mockResolvedValueOnce(graphqlResponse({
        issueUpdate: { success: true },
      }));

      const result = await client.updateIssueState("issue-1", "state-in-progress");
      expect(result).toBe(true);
    });

    it("returns false on API error", async () => {
      mockFetch.mockResolvedValueOnce(httpErrorResponse(500, "Internal Server Error"));

      const result = await client.updateIssueState("issue-1", "state-bad");
      expect(result).toBe(false);
    });
  });

  // ── getIssue ──────────────────────────────────────────────────────

  describe("getIssue", () => {
    it("fetches issue by ID", async () => {
      mockFetch.mockResolvedValueOnce(graphqlResponse({
        issue: SAMPLE_ISSUE,
      }));

      const issue = await client.getIssue("issue-uuid-1");

      expect(issue).not.toBeNull();
      expect(issue?.identifier).toBe("ENG-123");
    });

    it("returns null when issue not found (falls back to search)", async () => {
      // First call: issue query fails
      mockFetch.mockResolvedValueOnce(graphqlErrorResponse([
        { message: "Entity not found" },
      ]));

      // Fallback search returns empty
      mockFetch.mockResolvedValueOnce(graphqlResponse({
        issueSearch: { nodes: [] },
      }));

      const issue = await client.getIssue("nonexistent");
      expect(issue).toBeNull();
    });

    it("falls back to search by identifier", async () => {
      // First call: issue query fails (identifier is not a UUID)
      mockFetch.mockResolvedValueOnce(graphqlErrorResponse([
        { message: "Invalid ID format" },
      ]));

      // Fallback search finds the issue
      mockFetch.mockResolvedValueOnce(graphqlResponse({
        issueSearch: { nodes: [SAMPLE_ISSUE] },
      }));

      const issue = await client.getIssue("ENG-123");
      expect(issue).not.toBeNull();
      expect(issue?.identifier).toBe("ENG-123");
    });
  });

  // ── listIssues ────────────────────────────────────────────────────

  describe("listIssues", () => {
    it("lists issues with default params", async () => {
      mockFetch.mockResolvedValueOnce(graphqlResponse({
        issues: { nodes: [SAMPLE_ISSUE] },
      }));

      const issues = await client.listIssues();

      expect(issues).toHaveLength(1);
      expect(issues[0].identifier).toBe("ENG-123");
    });

    it("filters by team and state", async () => {
      mockFetch.mockResolvedValueOnce(graphqlResponse({
        issues: { nodes: [] },
      }));

      await client.listIssues({ teamId: "team-2", stateName: "In Progress", limit: 10 });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.query).toContain("team-2");
      expect(body.query).toContain("In Progress");
      expect(body.variables.limit).toBe(10);
    });
  });

  // ── Error handling ────────────────────────────────────────────────

  describe("error handling", () => {
    it("throws LinearClientError on 401 Unauthorized", async () => {
      mockFetch.mockResolvedValueOnce(httpErrorResponse(401, "Unauthorized"));

      await expect(client.getTeams()).rejects.toThrow(LinearClientError);
      try {
        mockFetch.mockResolvedValueOnce(httpErrorResponse(401, "Unauthorized"));
        await client.getTeams();
      } catch (err) {
        expect((err as LinearClientError).statusCode).toBe(401);
      }
    });

    it("throws LinearClientError on GraphQL errors", async () => {
      mockFetch.mockResolvedValueOnce(graphqlErrorResponse([
        { message: "Team not found" },
        { message: "Permission denied" },
      ]));

      try {
        await client.getTeams();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(LinearClientError);
        expect((err as LinearClientError).message).toContain("Team not found");
        expect((err as LinearClientError).message).toContain("Permission denied");
      }
    });

    it("throws LinearClientError on network timeout", async () => {
      const timeoutErr = new Error("The operation was aborted");
      timeoutErr.name = "TimeoutError";
      mockFetch.mockRejectedValueOnce(timeoutErr);

      try {
        await client.getTeams();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(LinearClientError);
        expect((err as LinearClientError).linearMessage).toBe("timeout");
      }
    });

    it("throws LinearClientError on generic network failure", async () => {
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      await expect(client.getTeams()).rejects.toThrow(LinearClientError);
    });

    it("throws LinearClientError when data is null/undefined", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ data: null }),
        text: async () => "{}",
      } as unknown as Response);

      await expect(client.getTeams()).rejects.toThrow("empty data");
    });
  });

  // ── Auth header ───────────────────────────────────────────────────

  describe("authentication", () => {
    it("sends API key as Authorization header", async () => {
      mockFetch.mockResolvedValueOnce(graphqlResponse({
        teams: { nodes: [] },
      }));

      await client.getTeams();

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers.Authorization).toBe("lin_test_key");
      expect(headers["Content-Type"]).toBe("application/json");
    });
  });
});
