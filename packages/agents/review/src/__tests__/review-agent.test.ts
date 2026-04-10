import { describe, it, expect, beforeEach } from "vitest";
import { ReviewAgent } from "../review-agent.js";
import type { AgentConfig, NormalizedMessage, ParsedIntent } from "@codespar/core";

function makeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    id: "agent-review-test",
    type: "review",
    autonomyLevel: 2,
    projectId: "proj-1",
    orgId: "org-1",
    ...overrides,
  };
}

function makeMessage(overrides?: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    id: "msg-1",
    channelType: "cli",
    channelId: "ch-1",
    channelUserId: "user-alice",
    isDM: false,
    isMentioningBot: true,
    text: "review PR #42",
    timestamp: new Date(),
    ...overrides,
  };
}

function makeIntent(
  type: string,
  params: Record<string, string> = {}
): ParsedIntent {
  return {
    type: type as ParsedIntent["type"],
    risk: "low",
    params,
    rawText: type,
    confidence: 1,
  };
}

describe("ReviewAgent", () => {
  let agent: ReviewAgent;

  beforeEach(async () => {
    agent = new ReviewAgent(makeConfig());
    await agent.initialize();
  });

  it("creates instance and initializes to IDLE", () => {
    expect(agent).toBeInstanceOf(ReviewAgent);
    expect(agent.state).toBe("IDLE");
    expect(agent.config.type).toBe("review");
    expect(agent.config.id).toBe("agent-review-test");
  });

  it("handles review intent without PR number — returns usage", async () => {
    const message = makeMessage();
    const intent = makeIntent("review", {});

    const response = await agent.handleMessage(message, intent);

    expect(response.text).toContain("Usage:");
    expect(response.text).toContain("review PR #<number>");
  });

  it("handles review intent with PR number — metadata-only when GitHub not configured", async () => {
    const message = makeMessage();
    const intent = makeIntent("review", { prNumber: "42" });

    const response = await agent.handleMessage(message, intent);

    // Without GITHUB_TOKEN, falls back to metadata-only review
    expect(response.text).toContain("PR #42 Review");
    expect(response.text).toContain("metadata-only review");
    expect(response.text).toContain("GITHUB_TOKEN");

    // Should be tracked in review history
    const history = agent.getReviewHistory();
    expect(history).toHaveLength(1);
    expect(history[0].prNumber).toBe(42);
    expect(history[0].summary).toContain("Metadata-only");
  });

  it("handles non-review intent gracefully", async () => {
    const message = makeMessage();
    const intent = makeIntent("deploy");

    const response = await agent.handleMessage(message, intent);

    expect(response.text).toContain("does not handle");
    expect(response.text).toContain("deploy");
  });

  it("getStatus returns correct values", () => {
    const status = agent.getStatus();

    expect(status.id).toBe("agent-review-test");
    expect(status.type).toBe("review");
    expect(status.state).toBe("IDLE");
    expect(status.autonomyLevel).toBe(2);
    expect(status.projectId).toBe("proj-1");
    expect(status.orgId).toBe("org-1");
    expect(status.tasksHandled).toBe(0);
    expect(status.uptimeMs).toBeGreaterThanOrEqual(0);
  });

  it("increments tasksHandled after handling a message", async () => {
    await agent.handleMessage(
      makeMessage(),
      makeIntent("review", { prNumber: "10" })
    );

    const status = agent.getStatus();
    expect(status.tasksHandled).toBe(1);
    expect(status.state).toBe("IDLE");
  });

  it("getReviewHistory returns a copy of history", async () => {
    await agent.handleMessage(
      makeMessage(),
      makeIntent("review", { prNumber: "10" })
    );

    const history = agent.getReviewHistory();
    expect(history).toHaveLength(1);

    // Verify it returns a copy
    history.push({} as any);
    expect(agent.getReviewHistory()).toHaveLength(1);
  });

  it("shutdown transitions to TERMINATED", async () => {
    await agent.shutdown();
    expect(agent.state).toBe("TERMINATED");
  });
});
