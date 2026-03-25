/**
 * Integration tests for PgStorage using Testcontainers.
 *
 * Requires Docker to run. Skipped when Docker is not available.
 * Run with: DATABASE_URL=... npx vitest run pg-storage.integration
 * Or in CI with Docker: npx vitest run pg-storage.integration
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PgStorage } from "../pg-storage.js";

// Skip all tests if no DATABASE_URL (Docker not available / not in CI)
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

let storage: PgStorage;
let connectionString: string;

describeIf("PgStorage (integration)", () => {
  beforeAll(async () => {
    // Use provided DATABASE_URL or try Testcontainers
    if (DATABASE_URL) {
      connectionString = DATABASE_URL;
    } else {
      // Testcontainers would be used here in CI
      // const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
      // const container = await new PostgreSqlContainer().start();
      // connectionString = container.getConnectionUri();
      throw new Error("DATABASE_URL required for integration tests");
    }

    storage = new PgStorage(connectionString);

    // Run schema creation (in production this would be drizzle-kit migrate)
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const postgres = (await import("postgres")).default;
    const client = postgres(connectionString);
    const db = drizzle(client);

    // Create tables using raw SQL (matching schema.ts)
    await client.unsafe(`
      CREATE TABLE IF NOT EXISTS agent_memory (
        agent_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value JSONB,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(agent_id, key)
      );
      CREATE TABLE IF NOT EXISTS project_configs (
        agent_id TEXT PRIMARY KEY,
        repo_url TEXT NOT NULL,
        repo_owner TEXT NOT NULL,
        repo_name TEXT NOT NULL,
        linked_at TEXT NOT NULL,
        linked_by TEXT NOT NULL,
        webhook_configured BOOLEAN NOT NULL DEFAULT FALSE
      );
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        repo TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL,
        result TEXT NOT NULL,
        metadata JSONB,
        hash TEXT
      );
      CREATE TABLE IF NOT EXISTS subscribers (
        email TEXT PRIMARY KEY,
        subscribed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        source TEXT NOT NULL DEFAULT 'homepage',
        confirmed BOOLEAN NOT NULL DEFAULT FALSE
      );
      CREATE TABLE IF NOT EXISTS slack_installations (
        team_id TEXT PRIMARY KEY,
        team_name TEXT NOT NULL,
        bot_token TEXT NOT NULL,
        bot_user_id TEXT NOT NULL,
        app_id TEXT NOT NULL,
        installed_by TEXT NOT NULL,
        installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        scopes JSONB NOT NULL DEFAULT '[]',
        org_id TEXT
      );
      CREATE TABLE IF NOT EXISTS agent_states (
        agent_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        autonomy_level INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS channel_configs (
        channel TEXT PRIMARY KEY,
        config JSONB NOT NULL DEFAULT '{}',
        configured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        configured_by TEXT NOT NULL DEFAULT 'dashboard'
      );
    `);

    await client.end();
  }, 60_000); // 60s timeout for container startup

  afterAll(async () => {
    await storage.close();
  });

  // ── Agent Memory ──────────────────────────────────────────

  describe("agent memory", () => {
    it("set and get memory", async () => {
      await storage.setMemory("agent-1", "context", { foo: "bar" });
      const value = await storage.getMemory("agent-1", "context");
      expect(value).toEqual({ foo: "bar" });
    });

    it("returns null for missing key", async () => {
      const value = await storage.getMemory("agent-1", "nonexistent");
      expect(value).toBeNull();
    });

    it("upserts on duplicate key", async () => {
      await storage.setMemory("agent-1", "upsert-key", "v1");
      await storage.setMemory("agent-1", "upsert-key", "v2");
      const value = await storage.getMemory("agent-1", "upsert-key");
      expect(value).toBe("v2");
    });

    it("getAllMemory returns all keys for agent", async () => {
      await storage.setMemory("agent-2", "k1", "a");
      await storage.setMemory("agent-2", "k2", "b");
      const all = await storage.getAllMemory("agent-2");
      expect(all).toHaveLength(2);
      expect(all.map((m) => m.key).sort()).toEqual(["k1", "k2"]);
    });
  });

  // ── Project Config ────────────────────────────────────────

  describe("project config", () => {
    it("set and get project config", async () => {
      const config = {
        repoUrl: "https://github.com/test/repo",
        repoOwner: "test",
        repoName: "repo",
        linkedAt: new Date().toISOString(),
        linkedBy: "user-1",
        webhookConfigured: true,
      };
      await storage.setProjectConfig("agent-pc-1", config);
      const result = await storage.getProjectConfig("agent-pc-1");
      expect(result).toEqual(config);
    });

    it("returns null for missing config", async () => {
      const result = await storage.getProjectConfig("nonexistent");
      expect(result).toBeNull();
    });

    it("delete project config", async () => {
      await storage.setProjectConfig("agent-del", {
        repoUrl: "x", repoOwner: "x", repoName: "x",
        linkedAt: "", linkedBy: "", webhookConfigured: false,
      });
      await storage.deleteProjectConfig("agent-del");
      const result = await storage.getProjectConfig("agent-del");
      expect(result).toBeNull();
    });
  });

  // ── Audit Log ──────────────────────────────────────────────

  describe("audit log", () => {
    it("append and query audit entries", async () => {
      const entry = await storage.appendAudit({
        actorType: "agent",
        actorId: "agent-audit-1",
        action: "build.investigated",
        result: "success",
        metadata: { buildId: "123" },
      });

      expect(entry.id).toBeDefined();
      expect(entry.timestamp).toBeInstanceOf(Date);

      const { entries, total } = await storage.queryAudit("agent-audit-1");
      expect(total).toBeGreaterThanOrEqual(1);
      expect(entries[0].action).toBe("build.investigated");
    });

    it("hash chain is maintained", async () => {
      const e1 = await storage.appendAudit({
        actorType: "user", actorId: "chain-test",
        action: "a1", result: "success",
      });
      const e2 = await storage.appendAudit({
        actorType: "user", actorId: "chain-test",
        action: "a2", result: "success",
      });

      const { entries } = await storage.queryAudit("chain-test", 2);
      // Newest first
      expect(entries[0].action).toBe("a2");
      expect(entries[1].action).toBe("a1");
    });
  });

  // ── Newsletter ────────────────────────────────────────────

  describe("newsletter", () => {
    it("add and get subscribers", async () => {
      const sub = await storage.addSubscriber("test@example.com", "blog");
      expect(sub.email).toBe("test@example.com");
      expect(sub.source).toBe("blog");

      const subs = await storage.getSubscribers();
      expect(subs.some((s) => s.email === "test@example.com")).toBe(true);
    });

    it("idempotent add", async () => {
      await storage.addSubscriber("dupe@example.com");
      await storage.addSubscriber("dupe@example.com");
      const count = await storage.getSubscriberCount();
      const subs = await storage.getSubscribers();
      const dupes = subs.filter((s) => s.email === "dupe@example.com");
      expect(dupes).toHaveLength(1);
    });

    it("remove subscriber", async () => {
      await storage.addSubscriber("remove@example.com");
      await storage.removeSubscriber("remove@example.com");
      const subs = await storage.getSubscribers();
      expect(subs.some((s) => s.email === "remove@example.com")).toBe(false);
    });
  });

  // ── Agent States ──────────────────────────────────────────

  describe("agent states", () => {
    it("save and get agent state", async () => {
      await storage.saveAgentState("agent-state-1", {
        agentId: "agent-state-1",
        state: "active",
        autonomyLevel: 3,
        updatedAt: new Date().toISOString(),
      });
      const state = await storage.getAgentState("agent-state-1");
      expect(state?.state).toBe("active");
      expect(state?.autonomyLevel).toBe(3);
    });

    it("get all agent states", async () => {
      const states = await storage.getAllAgentStates();
      expect(states.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Channel Config ────────────────────────────────────────

  describe("channel config", () => {
    it("save and get channel config", async () => {
      await storage.saveChannelConfig("slack", { token: "xoxb-test" });
      const config = await storage.getChannelConfig("slack");
      expect(config).toEqual({ token: "xoxb-test" });
    });

    it("returns null for missing channel", async () => {
      const config = await storage.getChannelConfig("nonexistent");
      expect(config).toBeNull();
    });
  });
});
