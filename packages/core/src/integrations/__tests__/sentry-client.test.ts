/**
 * Tests for SentryClient — mocks fetch for all API calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SentryClient, SentryClientError } from "../sentry-client.js";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonResponse(data: unknown, status = 200, headers?: Record<string, string>): Response {
  const headersObj = new Headers(headers);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: headersObj,
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as unknown as Response;
}

describe("SentryClient", () => {
  let client: SentryClient;

  beforeEach(() => {
    client = new SentryClient("test-token", "test-org", 5000);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── getUnresolvedIssues ─────────────────────────────────────────

  describe("getUnresolvedIssues", () => {
    it("fetches and parses unresolved issues", async () => {
      const rawIssues = [
        {
          id: "123",
          title: "TypeError: Cannot read property 'x' of undefined",
          culprit: "app/utils/parser.ts",
          level: "error",
          status: "unresolved",
          count: 42,
          userCount: 7,
          firstSeen: "2026-04-01T10:00:00Z",
          lastSeen: "2026-04-02T14:30:00Z",
          permalink: "https://sentry.io/issues/123/",
          project: { name: "my-app", slug: "my-app" },
          shortId: "MY-APP-1A2B",
        },
      ];

      mockFetch.mockResolvedValueOnce(jsonResponse(rawIssues));

      const issues = await client.getUnresolvedIssues("my-app", 10);

      expect(issues).toHaveLength(1);
      expect(issues[0].id).toBe("123");
      expect(issues[0].title).toBe("TypeError: Cannot read property 'x' of undefined");
      expect(issues[0].culprit).toBe("app/utils/parser.ts");
      expect(issues[0].level).toBe("error");
      expect(issues[0].count).toBe(42);
      expect(issues[0].userCount).toBe(7);
      expect(issues[0].project.slug).toBe("my-app");

      // Verify the URL includes project filter
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("project=my-app");
      expect(url).toContain("limit=10");
    });

    it("works without project filter", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([]));

      const issues = await client.getUnresolvedIssues();

      expect(issues).toEqual([]);
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).not.toContain("project=");
    });
  });

  // ── getIssueDetails ─────────────────────────────────────────────

  describe("getIssueDetails", () => {
    it("fetches issue details with extended fields", async () => {
      const raw = {
        id: "456",
        title: "ReferenceError: foo is not defined",
        culprit: "src/index.ts",
        level: "fatal",
        status: "unresolved",
        count: 100,
        userCount: 25,
        firstSeen: "2026-04-01T08:00:00Z",
        lastSeen: "2026-04-02T16:00:00Z",
        permalink: "https://sentry.io/issues/456/",
        project: { name: "api", slug: "api" },
        shortId: "API-X1Y2",
        annotations: ["Needs investigation"],
        assignedTo: { type: "user", name: "Alice" },
        isBookmarked: true,
        hasSeen: false,
        metadata: { type: "ReferenceError", value: "foo is not defined" },
      };

      mockFetch.mockResolvedValueOnce(jsonResponse(raw));

      const detail = await client.getIssueDetails("456");

      expect(detail.id).toBe("456");
      expect(detail.level).toBe("fatal");
      expect(detail.assignedTo).toEqual({ type: "user", name: "Alice" });
      expect(detail.isBookmarked).toBe(true);
      expect(detail.annotations).toEqual(["Needs investigation"]);

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("/issues/456/");
    });
  });

  // ── getIssueEvents ──────────────────────────────────────────────

  describe("getIssueEvents", () => {
    it("fetches and parses issue events with stack traces", async () => {
      const rawEvents = [
        {
          eventID: "evt-001",
          title: "TypeError: x is undefined",
          message: "",
          dateCreated: "2026-04-02T14:30:00Z",
          context: { browser: "Chrome 120" },
          tags: [{ key: "environment", value: "production" }],
          entries: [
            {
              type: "exception",
              data: {
                values: [
                  {
                    type: "TypeError",
                    value: "x is undefined",
                    stacktrace: {
                      frames: [
                        {
                          filename: "app/utils.ts",
                          lineNo: 42,
                          colNo: 10,
                          function: "parseData",
                          inApp: true,
                          context: [],
                        },
                      ],
                    },
                  },
                ],
              },
            },
          ],
          user: { id: "u-1", email: "test@example.com", ip_address: "1.2.3.4" },
        },
      ];

      mockFetch.mockResolvedValueOnce(jsonResponse(rawEvents));

      const events = await client.getIssueEvents("456", 5);

      expect(events).toHaveLength(1);
      expect(events[0].eventID).toBe("evt-001");
      expect(events[0].tags[0].value).toBe("production");
      expect(events[0].entries[0].type).toBe("exception");
      expect(events[0].user?.email).toBe("test@example.com");

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("/issues/456/events/");
      expect(url).toContain("limit=5");
    });
  });

  // ── resolveIssue ────────────────────────────────────────────────

  describe("resolveIssue", () => {
    it("resolves an issue successfully", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ status: "resolved" }));

      const result = await client.resolveIssue("789");

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain("/issues/789/");
      expect(opts.method).toBe("PUT");
      expect(JSON.parse(opts.body)).toEqual({ status: "resolved" });
    });

    it("returns false on API error", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ detail: "Not found" }, 404));

      const result = await client.resolveIssue("nonexistent");

      expect(result).toBe(false);
    });
  });

  // ── getErrorCount ───────────────────────────────────────────────

  describe("getErrorCount", () => {
    it("returns count from X-Hits header", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse([], 200, { "X-Hits": "37" }),
      );

      const count = await client.getErrorCount("my-app", new Date("2026-04-01T00:00:00Z"));

      expect(count).toBe(37);
    });

    it("falls back to counting issues when X-Hits is missing", async () => {
      // First call: no X-Hits header
      const headersWithoutHits = new Headers();
      const firstRes = {
        ok: true,
        status: 200,
        headers: headersWithoutHits,
        json: async () => [],
        text: async () => "[]",
      } as unknown as Response;
      mockFetch.mockResolvedValueOnce(firstRes);

      // Fallback call: returns issues array
      mockFetch.mockResolvedValueOnce(jsonResponse([{ id: "1" }, { id: "2" }, { id: "3" }]));

      const count = await client.getErrorCount("my-app", new Date("2026-04-01T00:00:00Z"));

      expect(count).toBe(3);
    });
  });

  // ── Error handling ──────────────────────────────────────────────

  describe("error handling", () => {
    it("throws SentryClientError on 401 Unauthorized", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ detail: "Invalid token" }, 401));

      await expect(client.getUnresolvedIssues()).rejects.toThrow(SentryClientError);
      await expect(client.getUnresolvedIssues()).rejects.toThrow(); // re-mock needed
    });

    it("throws SentryClientError with status code on 404", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ detail: "Not found" }, 404));

      try {
        await client.getIssueDetails("nonexistent");
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(SentryClientError);
        expect((err as SentryClientError).statusCode).toBe(404);
      }
    });

    it("throws SentryClientError on network timeout", async () => {
      const timeoutErr = new Error("The operation was aborted");
      timeoutErr.name = "TimeoutError";
      mockFetch.mockRejectedValueOnce(timeoutErr);

      try {
        await client.getUnresolvedIssues();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(SentryClientError);
        expect((err as SentryClientError).sentryMessage).toBe("timeout");
      }
    });

    it("throws SentryClientError on generic network failure", async () => {
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      await expect(client.getUnresolvedIssues()).rejects.toThrow(SentryClientError);
    });
  });
});
