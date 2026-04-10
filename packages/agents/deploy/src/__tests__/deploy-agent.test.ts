import { describe, it, expect, beforeEach } from "vitest";
import { DeployAgent } from "../deploy-agent.js";
import { ApprovalManager } from "@codespar/core";
import type {
  AgentConfig,
  NormalizedMessage,
  ParsedIntent,
} from "@codespar/core";

function makeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    id: "agent-deploy-test",
    type: "deploy",
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
    text: "deploy staging",
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
    risk: "high",
    params,
    rawText: type,
    confidence: 1,
  };
}

describe("DeployAgent", () => {
  let agent: DeployAgent;
  let approvalManager: ApprovalManager;

  beforeEach(async () => {
    approvalManager = new ApprovalManager();
    agent = new DeployAgent(makeConfig(), approvalManager);
    await agent.initialize();
  });

  it("creates instance and initializes to IDLE", () => {
    expect(agent).toBeInstanceOf(DeployAgent);
    expect(agent.state).toBe("IDLE");
    expect(agent.config.type).toBe("deploy");
    expect(agent.config.id).toBe("agent-deploy-test");
  });

  it("handles deploy intent — returns pending_approval for production", async () => {
    const message = makeMessage();
    const intent = makeIntent("deploy", { environment: "production" });

    const response = await agent.handleMessage(message, intent);

    expect(response.text).toContain("Deploy to production requested");
    expect(response.text).toContain("Requires 2 approval(s)");
    expect(response.text).toContain("@codespar approve");

    // Should be tracked in history
    const history = agent.getDeployHistory();
    expect(history).toHaveLength(1);
    expect(history[0].environment).toBe("production");
    expect(history[0].status).toBe("pending_approval");
    expect(history[0].requiredApprovals).toBe(2);
  });

  it("handles staging deploy — auto-approves with 1 approval", async () => {
    const message = makeMessage({ channelUserId: "user-alice" });
    const intent = makeIntent("deploy", { environment: "staging" });

    const deployResponse = await agent.handleMessage(message, intent);

    expect(deployResponse.text).toContain("Deploy to staging requested");
    expect(deployResponse.text).toContain("Requires 1 approval(s)");

    // Extract token from response
    const tokenMatch = deployResponse.text.match(
      /@codespar approve (\S+)/
    );
    expect(tokenMatch).not.toBeNull();
    const token = tokenMatch![1];

    // A different user approves (staging only needs 1)
    const approveMessage = makeMessage({ channelUserId: "user-bob" });
    const approveIntent = makeIntent("approve", { token });

    const approveResponse = await agent.handleMessage(
      approveMessage,
      approveIntent
    );

    expect(approveResponse.text).toContain("quorum met");
    expect(approveResponse.text).toContain("Deploy complete");

    // History should show deployed status
    const history = agent.getDeployHistory();
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("deployed");
  });

  it("handles unknown intent gracefully", async () => {
    const message = makeMessage();
    const intent = makeIntent("status");

    const response = await agent.handleMessage(message, intent);

    expect(response.text).toContain("does not handle");
    expect(response.text).toContain("status");
  });

  it("getStatus returns correct values", async () => {
    const status = agent.getStatus();

    expect(status.id).toBe("agent-deploy-test");
    expect(status.type).toBe("deploy");
    expect(status.state).toBe("IDLE");
    expect(status.autonomyLevel).toBe(2);
    expect(status.projectId).toBe("proj-1");
    expect(status.orgId).toBe("org-1");
    expect(status.tasksHandled).toBe(0);
    expect(status.uptimeMs).toBeGreaterThanOrEqual(0);

    // Handle a message so tasksHandled increments
    await agent.handleMessage(
      makeMessage(),
      makeIntent("deploy", { environment: "staging" })
    );

    const updatedStatus = agent.getStatus();
    expect(updatedStatus.tasksHandled).toBe(1);
    expect(updatedStatus.state).toBe("IDLE");
  });

  it("getDeployHistory returns deploy history", async () => {
    expect(agent.getDeployHistory()).toHaveLength(0);

    // Create a deploy
    await agent.handleMessage(
      makeMessage(),
      makeIntent("deploy", { environment: "staging" })
    );

    const history = agent.getDeployHistory();
    expect(history).toHaveLength(1);
    expect(history[0].environment).toBe("staging");

    // Verify it returns a copy (not a reference)
    history.push({} as any);
    expect(agent.getDeployHistory()).toHaveLength(1);
  });

  it("executeRollback marks deployed entry as rolled_back", async () => {
    // First create a deployed entry via executeDeploy
    agent.executeDeploy("staging");

    const historyBefore = agent.getDeployHistory();
    expect(historyBefore).toHaveLength(1);
    expect(historyBefore[0].status).toBe("deployed");

    // Now rollback
    const result = await agent.executeRollback("staging", "user-alice");

    expect(result.text).toContain("Rollback complete");
    expect(result.text).toContain("staging");

    // History: original deploy should be rolled_back, plus a new rollback entry
    const historyAfter = agent.getDeployHistory();
    expect(historyAfter).toHaveLength(2);
    expect(historyAfter[0].status).toBe("rolled_back");
    expect(historyAfter[1].status).toBe("deployed");
  });

  it("executeRollback returns error when no deployed release exists", async () => {
    const result = await agent.executeRollback("production", "user-alice");
    expect(result.text).toContain("No deployed release found");
  });

  it("shutdown transitions to TERMINATED", async () => {
    await agent.shutdown();
    expect(agent.state).toBe("TERMINATED");
  });
});
