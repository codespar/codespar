import { describe, it, expect, beforeEach, vi } from "vitest";
import { PlanningAgent } from "../planning-agent.js";
import type { AgentConfig, NormalizedMessage, ParsedIntent } from "@codespar/core";

function makeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return { id: "plan-test", type: "planning", autonomyLevel: 2, projectId: "proj-1", orgId: "org-1", ...overrides };
}

function makeMessage(overrides?: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    id: "msg-1", channelType: "cli", channelId: "ch-1", channelUserId: "user-alice",
    isDM: false, isMentioningBot: true, text: "plan add auth", timestamp: new Date(),
    ...overrides,
  };
}

function makeIntent(rawText: string): ParsedIntent {
  return { type: "instruct" as ParsedIntent["type"], risk: "medium", params: { instruction: rawText }, rawText, confidence: 1 };
}

describe("PlanningAgent", () => {
  let agent: PlanningAgent;

  beforeEach(async () => {
    agent = new PlanningAgent(makeConfig());
    await agent.initialize();
  });

  it("creates instance and initializes to IDLE", () => {
    expect(agent).toBeInstanceOf(PlanningAgent);
    expect(agent.state).toBe("IDLE");
    expect(agent.config.type).toBe("planning");
  });

  it("handleMessage returns API key error when no key set", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const res = await agent.handleMessage(makeMessage(), makeIntent("add auth"));
    expect(res.text).toContain("ANTHROPIC_API_KEY");
    expect(agent.state).toBe("IDLE");
  });

  it("getStatus returns correct values", () => {
    const status = agent.getStatus();
    expect(status.id).toBe("plan-test");
    expect(status.type).toBe("planning");
    expect(status.state).toBe("IDLE");
    expect(status.autonomyLevel).toBe(2);
    expect(status.tasksHandled).toBe(0);
  });

  it("approvePlan returns false for nonexistent plan", () => {
    expect(agent.approvePlan("plan-nonexistent")).toBe(false);
  });

  it("getPlans returns empty array initially", () => {
    expect(agent.getPlans()).toHaveLength(0);
  });

  it("shutdown transitions to TERMINATED and clears plans", async () => {
    await agent.shutdown();
    expect(agent.state).toBe("TERMINATED");
    expect(agent.getPlans()).toHaveLength(0);
  });
});
