import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { A2AClient, A2AClientError } from "../client.js";
import type { A2ATaskRequest } from "../../types/a2a.js";

// ── Mock fetch globally ──────────────────────────────────────────────

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Helpers ──────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(text: string, status: number): Response {
  return new Response(text, { status });
}

const AGENT_URL = "https://remote-agent.example.com";

const AGENT_JSON = {
  name: "RemoteAgent",
  version: "1.0.0",
  protocol: "a2a/1.0",
  agents: [
    {
      type: "task",
      displayName: "Task Agent",
      description: "Runs coding tasks",
      lifecycle: "ephemeral",
      skills: [
        { id: "task.code-execution", name: "Code Execution", description: "Execute code in sandbox" },
      ],
    },
  ],
};

const TASK_REQUEST: A2ATaskRequest = {
  id: "task-001",
  skill: "task.code-execution",
  input: { text: "Fix the bug in auth module" },
  metadata: { callerAgent: "https://my-agent.example.com/.well-known/agent.json" },
};

const TASK_RESPONSE = {
  id: "task-001",
  status: "working" as const,
  skill: "task.code-execution",
  agentType: "task",
  createdAt: 1700000000000,
  updatedAt: 1700000001000,
};

// ── discover() ───────────────────────────────────────────────────────

describe("A2AClient", () => {
  describe("discover()", () => {
    it("fetches and parses agent.json successfully", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(AGENT_JSON));

      const client = new A2AClient();
      const card = await client.discover(AGENT_URL);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe(`${AGENT_URL}/.well-known/agent.json`);

      expect(card.url).toBe(AGENT_URL);
      expect(card.name).toBe("RemoteAgent");
      expect(card.version).toBe("1.0.0");
      expect(card.protocol).toBe("a2a/1.0");
      expect(card.agents).toHaveLength(1);
      expect(card.agents[0].skills[0].id).toBe("task.code-execution");
      expect(card.discoveredAt).toBeGreaterThan(0);
    });

    it("strips trailing slashes from agent URL", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(AGENT_JSON));

      const client = new A2AClient();
      await client.discover(`${AGENT_URL}///`);

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe(`${AGENT_URL}/.well-known/agent.json`);
    });

    it("throws A2AClientError on 404", async () => {
      mockFetch.mockResolvedValueOnce(textResponse("Not Found", 404));

      const client = new A2AClient({ retries: 0 });

      await expect(client.discover(AGENT_URL)).rejects.toThrow(A2AClientError);
      await expect(client.discover(AGENT_URL)).rejects.toThrow(/404/);
    });

    it("throws on timeout (AbortError)", async () => {
      mockFetch.mockImplementation(() => {
        const error = new DOMException("The operation was aborted", "AbortError");
        return Promise.reject(error);
      });

      const client = new A2AClient({ timeout: 50, retries: 0 });

      await expect(client.discover(AGENT_URL)).rejects.toThrow(A2AClientError);
      await expect(client.discover(AGENT_URL)).rejects.toThrow(/timed out/);
    });

    it("defaults name to 'unknown' when missing", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ agents: [{ type: "task", skills: [] }] }),
      );

      const client = new A2AClient();
      const card = await client.discover(AGENT_URL);

      expect(card.name).toBe("unknown");
    });

    it("defaults agents to empty array when missing", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ name: "Bare" }));

      const client = new A2AClient();
      const card = await client.discover(AGENT_URL);

      expect(card.agents).toEqual([]);
    });
  });

  // ── submitTask() ─────────────────────────────────────────────────────

  describe("submitTask()", () => {
    it("POSTs to /a2a/tasks and returns task response", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(TASK_RESPONSE, 201));

      const client = new A2AClient();
      const result = await client.submitTask(AGENT_URL, TASK_REQUEST);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(`${AGENT_URL}/a2a/tasks`);
      expect(init.method).toBe("POST");
      expect(init.headers).toEqual({ "Content-Type": "application/json" });

      const sentBody = JSON.parse(init.body);
      expect(sentBody.id).toBe("task-001");
      expect(sentBody.metadata.callerAgent).toBe(
        "https://my-agent.example.com/.well-known/agent.json",
      );

      expect(result.id).toBe("task-001");
      expect(result.status).toBe("working");
    });

    it("throws on 400 response", async () => {
      mockFetch.mockResolvedValueOnce(
        textResponse("Bad Request", 400),
      );

      const client = new A2AClient({ retries: 0 });

      await expect(
        client.submitTask(AGENT_URL, TASK_REQUEST),
      ).rejects.toThrow(A2AClientError);
    });
  });

  // ── getTaskStatus() ──────────────────────────────────────────────────

  describe("getTaskStatus()", () => {
    it("GETs /a2a/tasks/:id and returns response", async () => {
      const completed = { ...TASK_RESPONSE, status: "completed" };
      mockFetch.mockResolvedValueOnce(jsonResponse(completed));

      const client = new A2AClient();
      const result = await client.getTaskStatus(AGENT_URL, "task-001");

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe(`${AGENT_URL}/a2a/tasks/task-001`);
      expect(result.status).toBe("completed");
    });

    it("throws on 404 (task not found)", async () => {
      mockFetch.mockResolvedValueOnce(textResponse("Not Found", 404));

      const client = new A2AClient({ retries: 0 });

      await expect(
        client.getTaskStatus(AGENT_URL, "nonexistent"),
      ).rejects.toThrow(A2AClientError);
    });
  });

  // ── cancelTask() ─────────────────────────────────────────────────────

  describe("cancelTask()", () => {
    it("POSTs to /a2a/tasks/:id/cancel", async () => {
      const cancelled = { ...TASK_RESPONSE, status: "cancelled" };
      mockFetch.mockResolvedValueOnce(jsonResponse(cancelled));

      const client = new A2AClient();
      const result = await client.cancelTask(AGENT_URL, "task-001");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(`${AGENT_URL}/a2a/tasks/task-001/cancel`);
      expect(init.method).toBe("POST");
      expect(result.status).toBe("cancelled");
    });

    it("throws on 400 (already completed)", async () => {
      mockFetch.mockResolvedValueOnce(
        textResponse("Cannot cancel completed task", 400),
      );

      const client = new A2AClient({ retries: 0 });

      await expect(
        client.cancelTask(AGENT_URL, "task-001"),
      ).rejects.toThrow(A2AClientError);
    });
  });

  // ── Retry logic ──────────────────────────────────────────────────────

  describe("retry on 5xx", () => {
    it("retries on 500 and succeeds on second attempt", async () => {
      mockFetch
        .mockResolvedValueOnce(textResponse("Internal Server Error", 500))
        .mockResolvedValueOnce(jsonResponse(AGENT_JSON));

      const client = new A2AClient({ retries: 2 });
      const card = await client.discover(AGENT_URL);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(card.name).toBe("RemoteAgent");
    });

    it("retries on 503 up to retries limit then returns last 503", async () => {
      mockFetch
        .mockResolvedValue(textResponse("Service Unavailable", 503));

      const client = new A2AClient({ retries: 2 });

      // After all retries exhausted, the 503 response is returned
      // and discover() throws because !response.ok
      await expect(client.discover(AGENT_URL)).rejects.toThrow(A2AClientError);
      expect(mockFetch).toHaveBeenCalledTimes(3); // initial + 2 retries
    });

    it("does not retry on 4xx", async () => {
      mockFetch.mockResolvedValueOnce(textResponse("Bad Request", 400));

      const client = new A2AClient({ retries: 2 });

      await expect(
        client.submitTask(AGENT_URL, TASK_REQUEST),
      ).rejects.toThrow(A2AClientError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("retries on network error and succeeds", async () => {
      mockFetch
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce(jsonResponse(AGENT_JSON));

      const client = new A2AClient({ retries: 1 });
      const card = await client.discover(AGENT_URL);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(card.name).toBe("RemoteAgent");
    });
  });
});
