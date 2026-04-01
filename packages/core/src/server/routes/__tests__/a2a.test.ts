/**
 * Tests for A2A inbound task routes.
 *
 * Uses a lightweight Fastify instance with the A2A routes registered
 * against the real agent metadata registry (populated via registerAllAgentMetadata).
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import Fastify from "fastify";
import { registerA2ARoutes, clearTaskStore } from "../a2a.js";
import { registerAllAgentMetadata } from "../../../agents/agent-metadata.js";
import type { ServerContext } from "../types.js";

// ── Test setup ────────────────────────────────────────────────────────

function createTestApp() {
  const app = Fastify({ logger: false });

  // Minimal ServerContext stub — A2A routes don't use most of it
  const ctx = {
    startedAt: new Date(),
    agentSupervisor: null,
    storageProvider: null,
    approvalManager: null,
    agentFactory: null,
    identityStore: null,
    vectorStore: null,
    eventBus: null,
    taskQueue: null,
    agentCount: 0,
    eventHandlers: [],
    chatHandler: null,
    alertHandler: null,
    storageBaseDir: ".codespar",
    _vercelDedup: new Map(),
    sseConnections: new Set(),
    getOrgId: () => "default",
    getOrgStorage: () => ({}),
    broadcastEvent: () => {},
  } as unknown as ServerContext;

  const route = (method: "get" | "post" | "delete", path: string, handler: any) => {
    app[method](path, handler);
  };

  registerA2ARoutes(route, ctx);
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("A2A task routes", () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(() => {
    // Populate agent metadata so skills are resolvable
    registerAllAgentMetadata();
  });

  beforeEach(() => {
    clearTaskStore();
    app = createTestApp();
  });

  // ── POST /a2a/tasks ─────────────────────────────────────────────────

  describe("POST /a2a/tasks", () => {
    it("should accept a valid task and return 201 with status", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/a2a/tasks",
        payload: {
          skill: "task.code-execution",
          input: { text: "Add error handling to auth module" },
          metadata: { callerAgent: "https://example.com/.well-known/agent.json" },
        },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.id).toBeDefined();
      expect(body.status).toBe("working");
      expect(body.skill).toBe("task.code-execution");
      expect(body.agentType).toBe("task");
      expect(body.createdAt).toBeTypeOf("number");
    });

    it("should use the provided task ID when given", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/a2a/tasks",
        payload: {
          id: "custom-task-123",
          skill: "review.pr-analysis",
          input: { text: "Review PR #42" },
        },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().id).toBe("custom-task-123");
    });

    it("should reject duplicate task IDs with 409", async () => {
      const payload = {
        id: "dup-task",
        skill: "task.code-execution",
        input: { text: "Do something" },
      };

      await app.inject({ method: "POST", url: "/a2a/tasks", payload });
      const response = await app.inject({ method: "POST", url: "/a2a/tasks", payload });

      expect(response.statusCode).toBe(409);
      expect(response.json().error).toContain("already exists");
    });

    it("should reject requests with missing skill (400)", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/a2a/tasks",
        payload: {
          input: { text: "Do something" },
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain("skill");
    });

    it("should reject requests with missing input.text (400)", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/a2a/tasks",
        payload: {
          skill: "task.code-execution",
          input: {},
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it("should reject unknown skills with 400 and list available skills", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/a2a/tasks",
        payload: {
          skill: "nonexistent.skill",
          input: { text: "Test" },
        },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error).toContain("Unknown skill");
      expect(body.error).toContain("task.code-execution");
    });
  });

  // ── GET /a2a/tasks/:id ──────────────────────────────────────────────

  describe("GET /a2a/tasks/:id", () => {
    it("should return task details for a valid ID", async () => {
      // Create a task first
      const createRes = await app.inject({
        method: "POST",
        url: "/a2a/tasks",
        payload: {
          id: "lookup-task",
          skill: "task.code-execution",
          input: { text: "Fix the bug" },
        },
      });
      expect(createRes.statusCode).toBe(201);

      const response = await app.inject({
        method: "GET",
        url: "/a2a/tasks/lookup-task",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.id).toBe("lookup-task");
      expect(body.status).toBe("working");
      expect(body.skill).toBe("task.code-execution");
      expect(body.agentType).toBe("task");
    });

    it("should return 404 for a non-existent task", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/a2a/tasks/does-not-exist",
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error).toContain("not found");
    });
  });

  // ── POST /a2a/tasks/:id/cancel ─────────────────────────────────────

  describe("POST /a2a/tasks/:id/cancel", () => {
    it("should cancel a working task", async () => {
      await app.inject({
        method: "POST",
        url: "/a2a/tasks",
        payload: {
          id: "cancel-me",
          skill: "task.code-execution",
          input: { text: "Long running task" },
        },
      });

      const response = await app.inject({
        method: "POST",
        url: "/a2a/tasks/cancel-me/cancel",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.id).toBe("cancel-me");
      expect(body.status).toBe("cancelled");

      // Verify the task status persists
      const getRes = await app.inject({
        method: "GET",
        url: "/a2a/tasks/cancel-me",
      });
      expect(getRes.json().status).toBe("cancelled");
    });

    it("should return 404 when cancelling a non-existent task", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/a2a/tasks/ghost/cancel",
      });

      expect(response.statusCode).toBe(404);
    });

    it("should reject cancelling an already-cancelled task", async () => {
      await app.inject({
        method: "POST",
        url: "/a2a/tasks",
        payload: {
          id: "double-cancel",
          skill: "review.pr-analysis",
          input: { text: "Review something" },
        },
      });

      // First cancel succeeds
      await app.inject({ method: "POST", url: "/a2a/tasks/double-cancel/cancel" });

      // Second cancel fails
      const response = await app.inject({
        method: "POST",
        url: "/a2a/tasks/double-cancel/cancel",
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain("cannot be cancelled");
    });
  });

  // ── GET /a2a/tasks ──────────────────────────────────────────────────

  describe("GET /a2a/tasks", () => {
    it("should return an empty list when no tasks exist", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/a2a/tasks",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.tasks).toEqual([]);
      expect(body.total).toBe(0);
    });

    it("should list all tasks with pagination metadata", async () => {
      // Create 3 tasks
      for (let i = 1; i <= 3; i++) {
        await app.inject({
          method: "POST",
          url: "/a2a/tasks",
          payload: {
            id: `list-task-${i}`,
            skill: "task.code-execution",
            input: { text: `Task ${i}` },
          },
        });
      }

      const response = await app.inject({
        method: "GET",
        url: "/a2a/tasks",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.tasks).toHaveLength(3);
      expect(body.total).toBe(3);
      expect(body.limit).toBe(50);
      expect(body.offset).toBe(0);
    });

    it("should respect limit and offset query params", async () => {
      for (let i = 1; i <= 5; i++) {
        await app.inject({
          method: "POST",
          url: "/a2a/tasks",
          payload: {
            id: `page-task-${i}`,
            skill: "task.code-execution",
            input: { text: `Task ${i}` },
          },
        });
      }

      const response = await app.inject({
        method: "GET",
        url: "/a2a/tasks?limit=2&offset=1",
      });

      const body = response.json();
      expect(body.tasks).toHaveLength(2);
      expect(body.total).toBe(5);
      expect(body.limit).toBe(2);
      expect(body.offset).toBe(1);
    });
  });
});
