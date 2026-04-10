import { describe, it, expect, beforeEach, vi } from "vitest";
import { AgentSupervisor } from "../supervisor.js";
import { MessageRouter } from "@codespar/core";
import type { Agent, AgentConfig, AgentState, AgentStatus, NormalizedMessage, ChannelResponse, ParsedIntent } from "@codespar/core";

/** Minimal stub agent for testing supervisor registration and lifecycle. */
function makeStubAgent(id = "agent-stub"): Agent {
  let _state: AgentState = "INITIALIZING";
  const config: AgentConfig = { id, type: "project", autonomyLevel: 1, projectId: "proj-1", orgId: "org-1" };
  return {
    config,
    get state() { return _state; },
    async initialize() { _state = "IDLE"; },
    async shutdown() { _state = "TERMINATED"; },
    async handleMessage(_msg: NormalizedMessage, _intent: ParsedIntent): Promise<ChannelResponse> {
      return { text: "ok" };
    },
    getStatus(): AgentStatus {
      return { id: config.id, type: config.type, state: _state, autonomyLevel: 1, projectId: "proj-1", orgId: "org-1", lastActiveAt: new Date(), uptimeMs: 0, tasksHandled: 0 };
    },
  };
}

describe("AgentSupervisor", () => {
  let supervisor: AgentSupervisor;
  let router: MessageRouter;

  beforeEach(() => {
    router = new MessageRouter();
    supervisor = new AgentSupervisor(router);
  });

  it("creates instance", () => {
    expect(supervisor).toBeInstanceOf(AgentSupervisor);
    expect(supervisor.getAgentStatuses()).toHaveLength(0);
  });

  it("registers agents via spawnAgent", async () => {
    const agent = makeStubAgent("agent-a");
    await supervisor.spawnAgent("proj-1", agent);

    expect(agent.state).toBe("IDLE");
    expect(supervisor.getAgentStatuses()).toHaveLength(1);
    expect(supervisor.getAgentStatuses()[0].id).toBe("agent-a");
  });

  it("getAgentById and getProjectIdForAgent resolve correctly", async () => {
    const agent = makeStubAgent("agent-x");
    await supervisor.spawnAgent("proj-x", agent);

    expect(supervisor.getAgentById("agent-x")).toBe(agent);
    expect(supervisor.getAgentById("nonexistent")).toBeUndefined();
    expect(supervisor.getProjectIdForAgent("agent-x")).toBe("proj-x");
  });

  it("removeAgent shuts down and unregisters", async () => {
    const agent = makeStubAgent("agent-rm");
    await supervisor.spawnAgent("proj-rm", agent);

    const removed = await supervisor.removeAgent("proj-rm");
    expect(removed).toBe(true);
    expect(agent.state).toBe("TERMINATED");
    expect(supervisor.getAgentStatuses()).toHaveLength(0);

    // Removing again returns false
    expect(await supervisor.removeAgent("proj-rm")).toBe(false);
  });

  it("restartAgent re-initializes agent", async () => {
    const agent = makeStubAgent("agent-restart");
    await supervisor.spawnAgent("proj-r", agent);
    expect(agent.state).toBe("IDLE");

    const ok = await supervisor.restartAgent("agent-restart");
    expect(ok).toBe(true);
    expect(agent.state).toBe("IDLE"); // shutdown then initialize -> IDLE

    expect(await supervisor.restartAgent("nonexistent")).toBe(false);
  });

  it("shutdown stops all agents", async () => {
    const a1 = makeStubAgent("a1");
    const a2 = makeStubAgent("a2");
    await supervisor.spawnAgent("p1", a1);
    await supervisor.spawnAgent("p2", a2);

    await supervisor.shutdown();

    expect(a1.state).toBe("TERMINATED");
    expect(a2.state).toBe("TERMINATED");
    expect(supervisor.getAgentStatuses()).toHaveLength(0);
  });
});
