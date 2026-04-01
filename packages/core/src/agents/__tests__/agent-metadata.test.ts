import { describe, it, expect, beforeAll } from "vitest";
import { registerAllAgentMetadata, AGENT_METADATA } from "../agent-metadata.js";
import { getAllAgentMetadata, getAgentMetadata } from "../agent-registry.js";
import type { AgentType, AgentMetadata } from "../../types/agent.js";

const ALL_AGENT_TYPES: AgentType[] = [
  "project",
  "task",
  "review",
  "deploy",
  "incident",
  "coordinator",
  "planning",
  "lens",
];

describe("A2A Agent Metadata", () => {
  beforeAll(() => {
    registerAllAgentMetadata();
  });

  // ── Coverage ──────────────────────────────────────────────────────
  describe("agent type coverage", () => {
    it("has metadata defined for all 8 agent types", () => {
      expect(AGENT_METADATA).toHaveLength(8);
      const types = AGENT_METADATA.map((m) => m.type);
      for (const type of ALL_AGENT_TYPES) {
        expect(types).toContain(type);
      }
    });

    it("registers all 8 agent types in the registry", () => {
      const registered = getAllAgentMetadata();
      expect(registered).toHaveLength(8);
    });

    it("can retrieve each agent type individually", () => {
      for (const type of ALL_AGENT_TYPES) {
        const meta = getAgentMetadata(type);
        expect(meta).toBeDefined();
        expect(meta!.type).toBe(type);
      }
    });
  });

  // ── Structure ─────────────────────────────────────────────────────
  describe("metadata structure", () => {
    it.each(ALL_AGENT_TYPES)("%s has required fields", (type) => {
      const meta = getAgentMetadata(type)!;
      expect(meta.type).toBe(type);
      expect(typeof meta.displayName).toBe("string");
      expect(meta.displayName.length).toBeGreaterThan(0);
      expect(typeof meta.description).toBe("string");
      expect(meta.description.length).toBeGreaterThan(0);
      expect(["persistent", "ephemeral"]).toContain(meta.lifecycle);
    });

    it.each(ALL_AGENT_TYPES)("%s has valid capabilities", (type) => {
      const meta = getAgentMetadata(type)!;
      expect(typeof meta.capabilities.streaming).toBe("boolean");
      expect(typeof meta.capabilities.pushNotifications).toBe("boolean");
      expect(Array.isArray(meta.capabilities.autonomyLevels)).toBe(true);
      expect(meta.capabilities.autonomyLevels.length).toBeGreaterThan(0);
    });

    it.each(ALL_AGENT_TYPES)("%s has requiredServices array", (type) => {
      const meta = getAgentMetadata(type)!;
      expect(Array.isArray(meta.requiredServices)).toBe(true);
      expect(meta.requiredServices.length).toBeGreaterThan(0);
    });
  });

  // ── Skills ────────────────────────────────────────────────────────
  describe("skills", () => {
    it.each(ALL_AGENT_TYPES)("%s has at least 2 skills", (type) => {
      const meta = getAgentMetadata(type)!;
      expect(meta.skills.length).toBeGreaterThanOrEqual(2);
    });

    it.each(ALL_AGENT_TYPES)("%s skills have valid structure", (type) => {
      const meta = getAgentMetadata(type)!;
      for (const skill of meta.skills) {
        expect(typeof skill.id).toBe("string");
        expect(skill.id.length).toBeGreaterThan(0);
        expect(typeof skill.name).toBe("string");
        expect(skill.name.length).toBeGreaterThan(0);
        expect(typeof skill.description).toBe("string");
        expect(skill.description.length).toBeGreaterThan(0);
        expect(Array.isArray(skill.inputModes)).toBe(true);
        expect(skill.inputModes.length).toBeGreaterThan(0);
        expect(Array.isArray(skill.outputModes)).toBe(true);
        expect(skill.outputModes.length).toBeGreaterThan(0);
      }
    });

    it("all skill IDs are unique", () => {
      const allSkillIds = AGENT_METADATA.flatMap((m) => m.skills.map((s) => s.id));
      const uniqueIds = new Set(allSkillIds);
      expect(uniqueIds.size).toBe(allSkillIds.length);
    });

    it("skill IDs follow the {type}.{action} naming convention", () => {
      for (const meta of AGENT_METADATA) {
        for (const skill of meta.skills) {
          expect(skill.id).toMatch(/^[a-z]+\.[a-z-]+$/);
          expect(skill.id.startsWith(`${meta.type}.`)).toBe(true);
        }
      }
    });
  });

  // ── Lifecycle ─────────────────────────────────────────────────────
  describe("lifecycle assignments", () => {
    it("project agent is persistent", () => {
      expect(getAgentMetadata("project")!.lifecycle).toBe("persistent");
    });

    it("coordinator agent is persistent", () => {
      expect(getAgentMetadata("coordinator")!.lifecycle).toBe("persistent");
    });

    it("task, review, deploy, incident, planning, lens are ephemeral", () => {
      const ephemeralTypes: AgentType[] = ["task", "review", "deploy", "incident", "planning", "lens"];
      for (const type of ephemeralTypes) {
        expect(getAgentMetadata(type)!.lifecycle).toBe("ephemeral");
      }
    });
  });
});
