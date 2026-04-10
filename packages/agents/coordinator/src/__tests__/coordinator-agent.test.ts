import { describe, it, expect, beforeEach } from "vitest";
import { CoordinatorAgent } from "../coordinator-agent.js";
import type { AgentConfig, NormalizedMessage, ParsedIntent } from "@codespar/core";

function makeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return { id: "coord-test", type: "coordinator", autonomyLevel: 2, orgId: "org-1", ...overrides };
}

function makeMessage(overrides?: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    id: "msg-1", channelType: "cli", channelId: "ch-1", channelUserId: "user-alice",
    isDM: false, isMentioningBot: true, text: "all status", timestamp: new Date(),
    ...overrides,
  };
}

function makeIntent(rawText: string, type = "unknown"): ParsedIntent {
  return { type: type as ParsedIntent["type"], risk: "low", params: {}, rawText, confidence: 1 };
}

describe("CoordinatorAgent", () => {
  let agent: CoordinatorAgent;

  beforeEach(async () => {
    agent = new CoordinatorAgent(makeConfig());
    await agent.initialize();
  });

  it("creates instance and initializes to IDLE", () => {
    expect(agent).toBeInstanceOf(CoordinatorAgent);
    expect(agent.state).toBe("IDLE");
    expect(agent.config.type).toBe("coordinator");
  });

  it("handles 'all status' with no projects", async () => {
    const res = await agent.handleMessage(makeMessage(), makeIntent("all status"));
    expect(res.text).toContain("No projects registered");
    expect(agent.state).toBe("IDLE");
  });

  it("handles 'all status' with registered projects", async () => {
    agent.registerProject("gw", "api-gateway", "agent-gw");
    const res = await agent.handleMessage(makeMessage(), makeIntent("all status"));
    expect(res.text).toContain("All projects status");
    expect(res.text).toContain("api-gateway");
  });

  it("handles unknown intent gracefully", async () => {
    const res = await agent.handleMessage(makeMessage({ text: "foo bar" }), makeIntent("foo bar"));
    expect(res.text).toContain("Unknown coordinator command");
    expect(res.text).toContain("Available");
  });

  it("getStatus returns correct values", async () => {
    const status = agent.getStatus();
    expect(status.id).toBe("coord-test");
    expect(status.type).toBe("coordinator");
    expect(status.state).toBe("IDLE");
    expect(status.autonomyLevel).toBe(2);
    expect(status.tasksHandled).toBe(0);
    expect(status.uptimeMs).toBeGreaterThanOrEqual(0);
  });

  it("tasksHandled increments on each message", async () => {
    await agent.handleMessage(makeMessage(), makeIntent("all status"));
    await agent.handleMessage(makeMessage(), makeIntent("all status"));
    expect(agent.getStatus().tasksHandled).toBe(2);
  });

  it("shutdown transitions to TERMINATED", async () => {
    await agent.shutdown();
    expect(agent.state).toBe("TERMINATED");
  });
});
