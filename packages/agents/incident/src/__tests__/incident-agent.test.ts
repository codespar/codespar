import { describe, it, expect, beforeEach } from "vitest";
import { IncidentAgent } from "../incident-agent.js";
import type { AgentConfig, CIEvent } from "@codespar/core";

function makeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    id: "agent-incident-test",
    type: "incident",
    autonomyLevel: 2,
    projectId: "proj-1",
    orgId: "org-1",
    ...overrides,
  };
}

function makeCIEvent(overrides?: Partial<CIEvent>): CIEvent {
  return {
    type: "check_run",
    repo: "codespar/codespar",
    branch: "main",
    status: "failure",
    details: {
      conclusion: "failure",
      title: "CI Build",
      sha: "abc12345def67890",
      prNumber: 42,
      commitsCount: 3,
    },
    timestamp: new Date(),
    ...overrides,
  };
}

describe("IncidentAgent", () => {
  let agent: IncidentAgent;

  beforeEach(async () => {
    agent = new IncidentAgent(makeConfig());
    await agent.initialize();
  });

  it("creates instance and initializes to IDLE", () => {
    expect(agent).toBeInstanceOf(IncidentAgent);
    expect(agent.state).toBe("IDLE");
    expect(agent.config.type).toBe("incident");
    expect(agent.config.id).toBe("agent-incident-test");
  });

  describe("classifySeverity", () => {
    it("classifies deploy failure as critical", () => {
      const event = makeCIEvent({
        details: { conclusion: "failure", title: "Deploy to production" },
      });
      expect(agent.classifySeverity(event)).toBe("critical");
    });

    it("classifies test failure as medium", () => {
      const event = makeCIEvent({
        details: { conclusion: "failure", title: "Run Tests" },
      });
      expect(agent.classifySeverity(event)).toBe("medium");
    });

    it("classifies build failure on main as critical", () => {
      const event = makeCIEvent({
        branch: "main",
        details: { conclusion: "failure", title: "Build" },
      });
      expect(agent.classifySeverity(event)).toBe("critical");
    });

    it("classifies build failure on feature branch as high", () => {
      const event = makeCIEvent({
        branch: "feature/new-thing",
        details: { conclusion: "failure", title: "Build" },
      });
      expect(agent.classifySeverity(event)).toBe("high");
    });

    it("classifies timed_out on main as high", () => {
      const event = makeCIEvent({
        branch: "main",
        details: { conclusion: "timed_out", title: "CI" },
      });
      expect(agent.classifySeverity(event)).toBe("high");
    });

    it("classifies timed_out on feature branch as medium", () => {
      const event = makeCIEvent({
        branch: "feature/x",
        details: { conclusion: "timed_out", title: "CI" },
      });
      expect(agent.classifySeverity(event)).toBe("medium");
    });

    it("classifies unknown conclusion as low", () => {
      const event = makeCIEvent({
        details: { conclusion: "neutral", title: "CI" },
      });
      expect(agent.classifySeverity(event)).toBe("low");
    });
  });

  it("handles CI event (investigate) and returns investigation", async () => {
    const event = makeCIEvent();

    const investigation = await agent.investigate(event);

    expect(investigation.error).toContain("main");
    expect(investigation.severity).toBe("critical"); // build failure on main
    expect(investigation.suspectedCause).toBeTruthy();
    expect(investigation.suggestedFix).toBeTruthy();
    expect(investigation.recentChanges.length).toBeGreaterThan(0);

    // Should include commit and PR info from the event
    const allChanges = investigation.recentChanges.join(" ");
    expect(allChanges).toContain("abc12345");
    expect(allChanges).toContain("#42");
  });

  it("correlateWithRecentChanges extracts commit info from event", async () => {
    const event = makeCIEvent({
      details: {
        sha: "deadbeef12345678",
        prNumber: 99,
        commitsCount: 5,
        title: "Lint & Test",
        conclusion: "failure",
      },
    });

    const changes = await agent.correlateWithRecentChanges(event);

    expect(changes).toContain("Commit: deadbeef");
    expect(changes).toContain("PR: #99");
    expect(changes).toContain("Commits in push: 5");
    expect(changes).toContain("Workflow: Lint & Test");
  });

  it("formatReport produces human-readable output", async () => {
    const event = makeCIEvent();
    const investigation = await agent.investigate(event);
    const report = agent.formatReport(investigation);

    expect(report).toContain("Build Failure Investigation");
    expect(report).toContain("Severity:");
    expect(report).toContain("Suspected cause:");
    expect(report).toContain("Suggested fix:");
  });

  it("getStatus returns correct values", () => {
    const status = agent.getStatus();

    expect(status.id).toBe("agent-incident-test");
    expect(status.type).toBe("incident");
    expect(status.state).toBe("IDLE");
    expect(status.autonomyLevel).toBe(2);
    expect(status.projectId).toBe("proj-1");
    expect(status.orgId).toBe("org-1");
    expect(status.tasksHandled).toBe(0);
    expect(status.uptimeMs).toBeGreaterThanOrEqual(0);
  });

  it("increments tasksHandled after investigation", async () => {
    await agent.investigate(makeCIEvent());

    const status = agent.getStatus();
    expect(status.tasksHandled).toBe(1);
    expect(status.state).toBe("IDLE");
  });

  it("handleMessage returns not-accepted message for direct commands", async () => {
    const response = await agent.handleMessage(
      {
        id: "msg-1",
        channelType: "cli",
        channelId: "ch-1",
        channelUserId: "user-1",
        isDM: false,
        isMentioningBot: true,
        text: "investigate",
        timestamp: new Date(),
      },
      {
        type: "unknown",
        risk: "low",
        params: {},
        rawText: "investigate",
        confidence: 1,
      }
    );

    expect(response.text).toContain("does not accept direct commands");
  });

  it("shutdown transitions to TERMINATED", async () => {
    await agent.shutdown();
    expect(agent.state).toBe("TERMINATED");
  });
});
