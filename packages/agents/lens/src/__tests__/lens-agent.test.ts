import { describe, it, expect, beforeEach } from "vitest";
import { LensAgent } from "../lens-agent.js";
import type { AgentConfig, NormalizedMessage, ParsedIntent } from "@codespar/core";

function makeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return { id: "lens-test", type: "lens", autonomyLevel: 1, projectId: "proj-1", orgId: "org-1", ...overrides };
}

function makeMessage(overrides?: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    id: "msg-1", channelType: "cli", channelId: "ch-1", channelUserId: "user-alice",
    isDM: false, isMentioningBot: true, text: "lens revenue last month", timestamp: new Date(),
    ...overrides,
  };
}

function makeIntent(rawText: string): ParsedIntent {
  return { type: "unknown" as ParsedIntent["type"], risk: "low", params: { question: rawText }, rawText, confidence: 1 };
}

describe("LensAgent", () => {
  let agent: LensAgent;

  beforeEach(async () => {
    agent = new LensAgent(makeConfig());
    await agent.initialize();
  });

  it("creates instance and initializes to IDLE", () => {
    expect(agent).toBeInstanceOf(LensAgent);
    expect(agent.state).toBe("IDLE");
    expect(agent.config.type).toBe("lens");
  });

  it("handleMessage returns API key error when no key set", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const res = await agent.handleMessage(makeMessage(), makeIntent("revenue last month"));
    expect(res.text).toContain("API key required");
    expect(agent.state).toBe("IDLE");
    expect(agent.getHistory()).toHaveLength(1);
    expect(agent.getHistory()[0].status).toBe("failed");
  });

  it("addDataSource and getDataSources work", () => {
    expect(agent.getDataSources()).toHaveLength(0);
    agent.addDataSource({ name: "main-db", type: "postgresql", tables: ["users", "orders"] });
    expect(agent.getDataSources()).toHaveLength(1);
    expect(agent.getDataSources()[0].name).toBe("main-db");
  });

  it("getStatus returns correct values", () => {
    const status = agent.getStatus();
    expect(status.id).toBe("lens-test");
    expect(status.type).toBe("lens");
    expect(status.state).toBe("IDLE");
    expect(status.autonomyLevel).toBe(1);
    expect(status.tasksHandled).toBe(0);
  });

  it("constructor accepts data sources", () => {
    const ds = [{ name: "analytics", type: "bigquery" as const }];
    const agentWithDs = new LensAgent(makeConfig(), ds);
    expect(agentWithDs.getDataSources()).toHaveLength(1);
  });

  it("shutdown transitions to TERMINATED", async () => {
    await agent.shutdown();
    expect(agent.state).toBe("TERMINATED");
  });
});
