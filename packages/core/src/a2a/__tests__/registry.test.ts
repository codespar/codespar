import { describe, it, expect, vi, beforeEach } from "vitest";
import { A2ARegistry } from "../registry.js";
import { A2AClient } from "../client.js";
import type { ExternalAgentCard } from "../../types/a2a.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeCard(
  url: string,
  name: string,
  skills: Array<{ id: string; name: string; description: string }> = [],
  discoveredAt = Date.now(),
): ExternalAgentCard {
  return {
    url,
    name,
    version: "1.0.0",
    protocol: "a2a/1.0",
    agents: [
      {
        type: "task",
        displayName: `${name} Task Agent`,
        description: `Task agent for ${name}`,
        lifecycle: "ephemeral",
        skills,
      },
    ],
    discoveredAt,
  };
}

const URL_A = "https://agent-a.example.com";
const URL_B = "https://agent-b.example.com";

const CARD_A = makeCard(URL_A, "AgentA", [
  { id: "task.code-execution", name: "Code Execution", description: "Runs code" },
  { id: "task.lint", name: "Lint", description: "Lints code" },
]);

const CARD_B = makeCard(URL_B, "AgentB", [
  { id: "review.pr-analysis", name: "PR Analysis", description: "Reviews PRs" },
]);

// ── Tests ────────────────────────────────────────────────────────────

describe("A2ARegistry", () => {
  let registry: A2ARegistry;
  let mockClient: A2AClient;

  beforeEach(() => {
    registry = new A2ARegistry(5_000); // 5 second TTL
    mockClient = new A2AClient();
    // Mock the discover method on the client
    vi.spyOn(mockClient, "discover");
  });

  // ── getOrDiscover() ──────────────────────────────────────────────

  describe("getOrDiscover()", () => {
    it("discovers on first call (cache miss)", async () => {
      vi.mocked(mockClient.discover).mockResolvedValueOnce(CARD_A);

      const card = await registry.getOrDiscover(URL_A, mockClient);

      expect(mockClient.discover).toHaveBeenCalledOnce();
      expect(mockClient.discover).toHaveBeenCalledWith(URL_A);
      expect(card.name).toBe("AgentA");
    });

    it("returns cached card on second call (cache hit)", async () => {
      vi.mocked(mockClient.discover).mockResolvedValueOnce(CARD_A);

      await registry.getOrDiscover(URL_A, mockClient);
      const card = await registry.getOrDiscover(URL_A, mockClient);

      // discover should only be called once
      expect(mockClient.discover).toHaveBeenCalledOnce();
      expect(card.name).toBe("AgentA");
    });

    it("re-discovers when TTL expires", async () => {
      // Create a card that was discovered 10 seconds ago (TTL is 5s)
      const expiredCard = makeCard(URL_A, "AgentA-Old", [], Date.now() - 10_000);
      const freshCard = makeCard(URL_A, "AgentA-Fresh");

      registry.register(URL_A, expiredCard);
      vi.mocked(mockClient.discover).mockResolvedValueOnce(freshCard);

      const card = await registry.getOrDiscover(URL_A, mockClient);

      expect(mockClient.discover).toHaveBeenCalledOnce();
      expect(card.name).toBe("AgentA-Fresh");
    });

    it("does not re-discover if TTL has not expired", async () => {
      // Card discovered just now — well within TTL
      const freshCard = makeCard(URL_A, "AgentA-Cached");
      registry.register(URL_A, freshCard);

      const card = await registry.getOrDiscover(URL_A, mockClient);

      expect(mockClient.discover).not.toHaveBeenCalled();
      expect(card.name).toBe("AgentA-Cached");
    });
  });

  // ── findSkill() ──────────────────────────────────────────────────

  describe("findSkill()", () => {
    it("finds a skill from agent A", () => {
      registry.register(URL_A, CARD_A);
      registry.register(URL_B, CARD_B);

      const result = registry.findSkill("task.code-execution");

      expect(result).toBeDefined();
      expect(result!.agentUrl).toBe(URL_A);
      expect(result!.card.name).toBe("AgentA");
    });

    it("finds a skill from agent B", () => {
      registry.register(URL_A, CARD_A);
      registry.register(URL_B, CARD_B);

      const result = registry.findSkill("review.pr-analysis");

      expect(result).toBeDefined();
      expect(result!.agentUrl).toBe(URL_B);
      expect(result!.card.name).toBe("AgentB");
    });

    it("returns undefined for unknown skill", () => {
      registry.register(URL_A, CARD_A);

      const result = registry.findSkill("deploy.rollback");

      expect(result).toBeUndefined();
    });

    it("returns undefined when registry is empty", () => {
      const result = registry.findSkill("task.code-execution");

      expect(result).toBeUndefined();
    });
  });

  // ── register() + list() ──────────────────────────────────────────

  describe("register() + list()", () => {
    it("registers and lists agents", () => {
      registry.register(URL_A, CARD_A);
      registry.register(URL_B, CARD_B);

      const agents = registry.list();

      expect(agents).toHaveLength(2);
      const names = agents.map((a) => a.name);
      expect(names).toContain("AgentA");
      expect(names).toContain("AgentB");
    });

    it("overwrites existing entry for same URL", () => {
      registry.register(URL_A, CARD_A);

      const updatedCard = makeCard(URL_A, "AgentA-v2");
      registry.register(URL_A, updatedCard);

      const agents = registry.list();
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe("AgentA-v2");
    });

    it("normalizes trailing slashes in URL key", () => {
      registry.register(`${URL_A}/`, CARD_A);
      registry.register(`${URL_A}///`, makeCard(URL_A, "AgentA-v2"));

      const agents = registry.list();
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe("AgentA-v2");
    });

    it("returns empty list when no agents registered", () => {
      expect(registry.list()).toEqual([]);
    });
  });

  // ── clear() ──────────────────────────────────────────────────────

  describe("clear()", () => {
    it("removes all cached entries", () => {
      registry.register(URL_A, CARD_A);
      registry.register(URL_B, CARD_B);

      expect(registry.list()).toHaveLength(2);

      registry.clear();

      expect(registry.list()).toHaveLength(0);
    });

    it("findSkill returns undefined after clear", () => {
      registry.register(URL_A, CARD_A);

      expect(registry.findSkill("task.code-execution")).toBeDefined();

      registry.clear();

      expect(registry.findSkill("task.code-execution")).toBeUndefined();
    });
  });
});
