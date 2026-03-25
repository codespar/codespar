import { describe, it, expect, vi, beforeEach } from "vitest";
import { TaskAgent, type TaskResult } from "../task-agent.js";
import type {
  AgentConfig,
  NormalizedMessage,
  ParsedIntent,
  StorageProvider,
} from "@codespar/core";

// ── Mock ClaudeBridge ─────────────────────────────────────────────
const { MockClaudeBridge, MockGitHubClient } = vi.hoisted(() => {
  class MockClaudeBridge {
    isAvailable = vi.fn().mockResolvedValue(true);
    execute = vi.fn().mockResolvedValue({
      taskId: "mock-task", status: "completed",
      output: "Mock execution completed successfully.",
      durationMs: 150, exitCode: 0, simulated: true,
    });
    executeWithRepo = vi.fn().mockResolvedValue({
      taskId: "mock-task", status: "completed",
      output: "Mock repo execution completed.",
      durationMs: 200, exitCode: 0, simulated: false,
    });
    executeStreaming = vi.fn().mockResolvedValue({
      taskId: "mock-task", status: "completed",
      output: "Mock streaming completed.",
      durationMs: 100, exitCode: 0, simulated: true,
    });
  }
  class MockGitHubClient {
    isConfigured = vi.fn().mockReturnValue(false);
  }
  return { MockClaudeBridge, MockGitHubClient };
});

vi.mock("@codespar/core", () => ({
  ClaudeBridge: MockClaudeBridge,
  GitHubClient: MockGitHubClient,
}));

// ── Helpers ───────────────────────────────────────────────────────
function makeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    id: "agent-test-task-1",
    type: "task",
    autonomyLevel: 1,
    projectId: "proj-1",
    ...overrides,
  };
}

function makeMessage(text: string, overrides?: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    id: "msg-1",
    channelType: "cli",
    channelId: "ch-1",
    channelUserId: "user-1",
    isDM: false,
    isMentioningBot: true,
    text,
    timestamp: new Date(),
    ...overrides,
  };
}

function makeIntent(type: ParsedIntent["type"], params: Record<string, string> = {}, rawText = ""): ParsedIntent {
  return {
    type,
    risk: "medium",
    params,
    rawText: rawText || `${type} command`,
    confidence: 1.0,
  };
}

function makeMockStorage(): StorageProvider {
  return {
    getMemory: vi.fn().mockResolvedValue(null),
    setMemory: vi.fn().mockResolvedValue(undefined),
    getAllMemory: vi.fn().mockResolvedValue([]),
    getProjectConfig: vi.fn().mockResolvedValue(null),
    setProjectConfig: vi.fn().mockResolvedValue(undefined),
    deleteProjectConfig: vi.fn().mockResolvedValue(undefined),
    getProjectsList: vi.fn().mockResolvedValue([]),
    addProject: vi.fn().mockResolvedValue(undefined),
    removeProject: vi.fn().mockResolvedValue(undefined),
    addSubscriber: vi.fn().mockResolvedValue({ email: "", subscribedAt: "", source: "", confirmed: false }),
    getSubscribers: vi.fn().mockResolvedValue([]),
    removeSubscriber: vi.fn().mockResolvedValue(undefined),
    getSubscriberCount: vi.fn().mockResolvedValue(0),
    saveSlackInstallation: vi.fn().mockResolvedValue(undefined),
    getSlackInstallation: vi.fn().mockResolvedValue(null),
    getAllSlackInstallations: vi.fn().mockResolvedValue([]),
    removeSlackInstallation: vi.fn().mockResolvedValue(undefined),
    saveAgentState: vi.fn().mockResolvedValue(undefined),
    getAgentState: vi.fn().mockResolvedValue(null),
    getAllAgentStates: vi.fn().mockResolvedValue([]),
    saveChannelConfig: vi.fn().mockResolvedValue(undefined),
    getChannelConfig: vi.fn().mockResolvedValue(null),
    appendAudit: vi.fn().mockResolvedValue({ id: "a-1", timestamp: new Date(), actorType: "user", actorId: "", action: "", result: "success" }),
    queryAudit: vi.fn().mockResolvedValue({ entries: [], total: 0 }),
  };
}

// ── Tests ─────────────────────────────────────────────────────────
describe("TaskAgent", () => {
  let agent: TaskAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new TaskAgent(makeConfig());
  });

  // ── Initialization ────────────────────────────────────────────
  describe("initialization", () => {
    it("starts in INITIALIZING state", () => {
      expect(agent.state).toBe("INITIALIZING");
    });

    it("transitions to IDLE after initialize()", async () => {
      await agent.initialize();
      expect(agent.state).toBe("IDLE");
    });

    it("sets config type to 'task'", () => {
      expect(agent.config.type).toBe("task");
    });

    it("preserves projectId from config", () => {
      expect(agent.config.projectId).toBe("proj-1");
    });
  });

  // ── handleMessage — instruct ──────────────────────────────────
  describe("handleMessage — instruct", () => {
    beforeEach(async () => {
      await agent.initialize();
    });

    it("executes an instruct command and returns response", async () => {
      const msg = makeMessage("instruct add a logger");
      const intent = makeIntent("instruct", { instruction: "add a logger" }, "instruct add a logger");

      const response = await agent.handleMessage(msg, intent);

      expect(response.text).toContain("Task");
      expect(response.text).toContain(agent.config.id);
    });

    it("returns to IDLE state after execution", async () => {
      const msg = makeMessage("instruct refactor utils");
      const intent = makeIntent("instruct", { instruction: "refactor utils" });

      await agent.handleMessage(msg, intent);

      expect(agent.state).toBe("IDLE");
    });

    it("increments tasksHandled in status", async () => {
      const statusBefore = agent.getStatus();
      expect(statusBefore.tasksHandled).toBe(0);

      const msg = makeMessage("instruct add test");
      const intent = makeIntent("instruct", { instruction: "add test" });
      await agent.handleMessage(msg, intent);

      const statusAfter = agent.getStatus();
      expect(statusAfter.tasksHandled).toBe(1);
    });
  });

  // ── handleMessage — fix ───────────────────────────────────────
  describe("handleMessage — fix", () => {
    beforeEach(async () => {
      await agent.initialize();
    });

    it("executes a fix command with 'Fix:' prefix in instruction", async () => {
      const msg = makeMessage("fix broken tests");
      const intent = makeIntent("fix", { issue: "broken tests" }, "fix broken tests");

      const response = await agent.handleMessage(msg, intent);

      expect(response.text).toContain("Task");
      expect(response.text).toContain(agent.config.id);
    });
  });

  // ── handleMessage — unsupported intent ────────────────────────
  describe("handleMessage — unsupported intent", () => {
    beforeEach(async () => {
      await agent.initialize();
    });

    it("returns a rejection message for unsupported intents", async () => {
      const msg = makeMessage("status");
      const intent = makeIntent("status");

      const response = await agent.handleMessage(msg, intent);

      expect(response.text).toContain("only handles instruct and fix");
    });
  });

  // ── Task queue ────────────────────────────────────────────────
  describe("task queue management", () => {
    beforeEach(async () => {
      await agent.initialize();
    });

    it("starts with an empty task queue", () => {
      expect(agent.getTaskQueue()).toHaveLength(0);
    });

    it("task queue is empty after completion (task is removed)", async () => {
      const msg = makeMessage("instruct add feature");
      const intent = makeIntent("instruct", { instruction: "add feature" });

      await agent.handleMessage(msg, intent);

      expect(agent.getTaskQueue()).toHaveLength(0);
    });
  });

  // ── Execution history ─────────────────────────────────────────
  describe("execution history", () => {
    beforeEach(async () => {
      await agent.initialize();
    });

    it("starts with empty execution history", () => {
      expect(agent.getExecutionHistory()).toHaveLength(0);
    });

    it("records completed tasks in execution history", async () => {
      const msg = makeMessage("instruct write docs");
      const intent = makeIntent("instruct", { instruction: "write docs" });

      await agent.handleMessage(msg, intent);

      const history = agent.getExecutionHistory();
      expect(history).toHaveLength(1);
      expect(history[0].status).toBe("completed");
      expect(history[0].instruction).toBe("write docs");
    });

    it("accumulates history across multiple tasks", async () => {
      for (let i = 0; i < 3; i++) {
        const msg = makeMessage(`instruct task-${i}`);
        const intent = makeIntent("instruct", { instruction: `task-${i}` });
        await agent.handleMessage(msg, intent);
      }

      expect(agent.getExecutionHistory()).toHaveLength(3);
    });
  });

  // ── getStatus ─────────────────────────────────────────────────
  describe("getStatus", () => {
    it("returns correct status fields", async () => {
      await agent.initialize();
      const status = agent.getStatus();

      expect(status.id).toBe("agent-test-task-1");
      expect(status.type).toBe("task");
      expect(status.state).toBe("IDLE");
      expect(status.autonomyLevel).toBe(1);
      expect(status.projectId).toBe("proj-1");
      expect(status.uptimeMs).toBeGreaterThanOrEqual(0);
      expect(status.tasksHandled).toBe(0);
    });
  });

  // ── Shutdown ──────────────────────────────────────────────────
  describe("shutdown", () => {
    it("transitions to TERMINATED state", async () => {
      await agent.initialize();
      await agent.shutdown();

      expect(agent.state).toBe("TERMINATED");
    });

    it("clears the task queue on shutdown", async () => {
      await agent.initialize();
      await agent.shutdown();

      expect(agent.getTaskQueue()).toHaveLength(0);
    });
  });
});
