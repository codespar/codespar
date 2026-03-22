import { describe, it, expect, beforeEach, afterAll } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { FileStorage } from "../file-storage.js";

const TEST_DIR = path.join(
  os.tmpdir(),
  `codespar-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
);

let storage: FileStorage;

beforeEach(async () => {
  // Each test gets a fresh storage instance with its own sub-directory
  // to avoid inter-test interference.
  const subDir = path.join(
    TEST_DIR,
    `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  storage = new FileStorage(subDir);
});

afterAll(async () => {
  // Clean up the temp directory
  try {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// ── Agent Memory ──────────────────────────────────────────────────
describe("Agent Memory", () => {
  it("setMemory and getMemory round-trip", async () => {
    await storage.setMemory("agent-1", "greeting", "hello world");
    const value = await storage.getMemory("agent-1", "greeting");
    expect(value).toBe("hello world");
  });

  it("getMemory returns null for non-existent key", async () => {
    const value = await storage.getMemory("agent-1", "does-not-exist");
    expect(value).toBeNull();
  });

  it("getMemory returns null for non-existent agent", async () => {
    const value = await storage.getMemory("no-such-agent", "key");
    expect(value).toBeNull();
  });

  it("setMemory overwrites existing value", async () => {
    await storage.setMemory("agent-1", "counter", 1);
    await storage.setMemory("agent-1", "counter", 2);
    const value = await storage.getMemory("agent-1", "counter");
    expect(value).toBe(2);
  });

  it("getAllMemory returns correct entries", async () => {
    await storage.setMemory("agent-1", "key-a", "val-a");
    await storage.setMemory("agent-1", "key-b", "val-b");
    await storage.setMemory("agent-2", "key-c", "val-c"); // different agent

    const entries = await storage.getAllMemory("agent-1");
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.key).sort()).toEqual(["key-a", "key-b"]);
    expect(entries[0].agentId).toBe("agent-1");
    expect(entries[0].updatedAt).toBeInstanceOf(Date);
  });

  it("getAllMemory returns empty array for unknown agent", async () => {
    const entries = await storage.getAllMemory("unknown");
    expect(entries).toEqual([]);
  });

  it("stores complex objects", async () => {
    const obj = { nested: { value: [1, 2, 3] }, flag: true };
    await storage.setMemory("agent-1", "config", obj);
    const value = await storage.getMemory("agent-1", "config");
    expect(value).toEqual(obj);
  });
});

// ── Audit Log ─────────────────────────────────────────────────────
describe("Audit Log", () => {
  it("appendAudit creates entry with id and timestamp", async () => {
    const entry = await storage.appendAudit({
      actorType: "user",
      actorId: "user-1",
      action: "deploy",
      result: "success",
    });
    expect(entry.id).toBeDefined();
    expect(typeof entry.id).toBe("string");
    expect(entry.timestamp).toBeInstanceOf(Date);
    expect(entry.action).toBe("deploy");
    expect(entry.result).toBe("success");
  });

  it("queryAudit returns entries in reverse chronological order", async () => {
    await storage.appendAudit({
      actorType: "user",
      actorId: "agent-x",
      action: "first",
      result: "success",
    });
    // Small delay to ensure different timestamps
    await storage.appendAudit({
      actorType: "user",
      actorId: "agent-x",
      action: "second",
      result: "success",
    });
    await storage.appendAudit({
      actorType: "user",
      actorId: "agent-x",
      action: "third",
      result: "success",
    });

    const result = await storage.queryAudit("agent-x");
    expect(result.entries).toHaveLength(3);
    expect(result.total).toBe(3);
    // Newest first
    expect(result.entries[0].action).toBe("third");
    expect(result.entries[2].action).toBe("first");
  });

  it("queryAudit with limit works", async () => {
    for (let i = 0; i < 5; i++) {
      await storage.appendAudit({
        actorType: "system",
        actorId: "agent-y",
        action: `action-${i}`,
        result: "success",
      });
    }

    const result = await storage.queryAudit("agent-y", 2);
    expect(result.entries).toHaveLength(2);
    expect(result.total).toBe(5);
  });

  it("queryAudit with offset works", async () => {
    for (let i = 0; i < 5; i++) {
      await storage.appendAudit({
        actorType: "system",
        actorId: "agent-z",
        action: `action-${i}`,
        result: "success",
      });
    }

    const result = await storage.queryAudit("agent-z", 2, 1);
    expect(result.entries).toHaveLength(2);
    // Reversed: [action-4, action-3, action-2, action-1, action-0]
    // offset 1, limit 2 → [action-3, action-2]
    expect(result.entries[0].action).toBe("action-3");
    expect(result.entries[1].action).toBe("action-2");
  });
});

// ── Project Config ────────────────────────────────────────────────
describe("Project Config", () => {
  const sampleConfig = {
    repoUrl: "https://github.com/owner/repo",
    repoOwner: "owner",
    repoName: "repo",
    linkedAt: "2025-01-01T00:00:00Z",
    linkedBy: "user-1",
    webhookConfigured: false,
  };

  it("setProjectConfig and getProjectConfig round-trip", async () => {
    await storage.setProjectConfig("agent-1", sampleConfig);
    const config = await storage.getProjectConfig("agent-1");
    expect(config).toEqual(sampleConfig);
  });

  it("getProjectConfig returns null for non-existent agent", async () => {
    const config = await storage.getProjectConfig("no-agent");
    expect(config).toBeNull();
  });

  it("deleteProjectConfig removes config", async () => {
    await storage.setProjectConfig("agent-1", sampleConfig);
    await storage.deleteProjectConfig("agent-1");
    const config = await storage.getProjectConfig("agent-1");
    expect(config).toBeNull();
  });
});

// ── Projects List ─────────────────────────────────────────────────
describe("Projects List", () => {
  it("addProject and getProjectsList", async () => {
    await storage.addProject({
      id: "proj-1",
      agentId: "agent-1",
      repo: "owner/repo",
    });
    const list = await storage.getProjectsList();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("proj-1");
    expect(list[0].createdAt).toBeDefined();
  });

  it("addProject is idempotent (same id)", async () => {
    await storage.addProject({
      id: "proj-1",
      agentId: "agent-1",
      repo: "owner/repo",
    });
    await storage.addProject({
      id: "proj-1",
      agentId: "agent-1",
      repo: "owner/repo",
    });
    const list = await storage.getProjectsList();
    expect(list).toHaveLength(1);
  });

  it("removeProject filters correctly", async () => {
    await storage.addProject({
      id: "proj-1",
      agentId: "agent-1",
      repo: "owner/repo-1",
    });
    await storage.addProject({
      id: "proj-2",
      agentId: "agent-2",
      repo: "owner/repo-2",
    });
    await storage.removeProject("proj-1");
    const list = await storage.getProjectsList();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("proj-2");
  });

  it("removeProject on empty list does not error", async () => {
    await expect(
      storage.removeProject("nonexistent"),
    ).resolves.toBeUndefined();
  });
});

// ── Agent State Persistence ──────────────────────────────────────
describe("Agent State Persistence", () => {
  it("saveAgentState and getAgentState round-trip", async () => {
    const state = {
      agentId: "agent-1",
      state: "suspended" as const,
      autonomyLevel: 3,
      updatedAt: "2025-01-01T00:00:00Z",
    };
    await storage.saveAgentState("agent-1", state);
    const result = await storage.getAgentState("agent-1");
    expect(result).toEqual(state);
  });

  it("getAgentState returns null for non-existent agent", async () => {
    const result = await storage.getAgentState("no-agent");
    expect(result).toBeNull();
  });

  it("saveAgentState overwrites existing entry", async () => {
    await storage.saveAgentState("agent-1", {
      agentId: "agent-1",
      state: "active",
      autonomyLevel: 1,
      updatedAt: "2025-01-01T00:00:00Z",
    });
    await storage.saveAgentState("agent-1", {
      agentId: "agent-1",
      state: "suspended",
      autonomyLevel: 4,
      updatedAt: "2025-01-02T00:00:00Z",
    });
    const result = await storage.getAgentState("agent-1");
    expect(result?.state).toBe("suspended");
    expect(result?.autonomyLevel).toBe(4);
  });

  it("getAllAgentStates returns all entries", async () => {
    await storage.saveAgentState("agent-1", {
      agentId: "agent-1",
      state: "active",
      autonomyLevel: 1,
      updatedAt: "2025-01-01T00:00:00Z",
    });
    await storage.saveAgentState("agent-2", {
      agentId: "agent-2",
      state: "suspended",
      autonomyLevel: 0,
      updatedAt: "2025-01-01T00:00:00Z",
    });
    const states = await storage.getAllAgentStates();
    expect(states).toHaveLength(2);
    expect(states.map((s) => s.agentId).sort()).toEqual(["agent-1", "agent-2"]);
  });

  it("getAllAgentStates returns empty array when no states", async () => {
    const states = await storage.getAllAgentStates();
    expect(states).toEqual([]);
  });
});

// ── Channel Configuration ────────────────────────────────────────
describe("Channel Configuration", () => {
  it("saveChannelConfig and getChannelConfig round-trip", async () => {
    const config = { botToken: "test-token-123" };
    await storage.saveChannelConfig("telegram", config);
    const result = await storage.getChannelConfig("telegram");
    expect(result).toEqual(config);
  });

  it("getChannelConfig returns null for non-existent channel", async () => {
    const result = await storage.getChannelConfig("nonexistent");
    expect(result).toBeNull();
  });

  it("saveChannelConfig overwrites existing config", async () => {
    await storage.saveChannelConfig("telegram", { botToken: "old-token" });
    await storage.saveChannelConfig("telegram", { botToken: "new-token" });
    const result = await storage.getChannelConfig("telegram");
    expect(result?.botToken).toBe("new-token");
  });

  it("saveChannelConfig stores multiple channels independently", async () => {
    await storage.saveChannelConfig("telegram", { botToken: "tg-token" });
    await storage.saveChannelConfig("discord", { botToken: "dc-token" });
    const tg = await storage.getChannelConfig("telegram");
    const dc = await storage.getChannelConfig("discord");
    expect(tg?.botToken).toBe("tg-token");
    expect(dc?.botToken).toBe("dc-token");
  });
});
