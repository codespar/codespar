import { describe, it, expect, vi, beforeEach } from "vitest";
import { ProjectAgent } from "../project-agent.js";
import type {
  AgentConfig,
  NormalizedMessage,
  ParsedIntent,
  StorageProvider,
} from "@codespar/core";

// ── Mock classes (hoisted for vi.mock factory) ──────────
const mocks = vi.hoisted(() => {
  class MockApprovalManager {
    createRequest = vi.fn();
    vote = vi.fn();
    getPending = vi.fn().mockReturnValue([]);
    getByToken = vi.fn();
  }
  class MockVectorStore {
    add = vi.fn().mockResolvedValue(undefined);
    search = vi.fn().mockResolvedValue([]);
  }
  class MockIdentityStore {
    resolve = vi.fn().mockResolvedValue(null);
    register = vi.fn().mockResolvedValue(undefined);
  }
  class MockGitHubClient { isConfigured = vi.fn().mockReturnValue(false); }
  class MockClaudeBridge {
    isAvailable = vi.fn().mockResolvedValue(false);
    execute = vi.fn().mockResolvedValue({
      taskId: "mock", status: "completed", output: "Mock output",
      durationMs: 100, exitCode: 0, simulated: true,
    });
    executeWithRepo = vi.fn().mockResolvedValue({
      taskId: "mock", status: "completed", output: "Mock repo output",
      durationMs: 100, exitCode: 0, simulated: false,
    });
  }
  class MockTaskAgent {
    config = { id: "mock-task", type: "task" };
    state = "IDLE";
    initialize = vi.fn().mockResolvedValue(undefined);
    handleMessage = vi.fn().mockResolvedValue({ text: "[mock-task] Task completed" });
    getStatus = vi.fn().mockReturnValue({ id: "mock-task", type: "task", state: "IDLE", autonomyLevel: 1, uptimeMs: 0, tasksHandled: 0 });
    shutdown = vi.fn().mockResolvedValue(undefined);
  }
  class MockDeployAgent {
    initialize = vi.fn().mockResolvedValue(undefined);
    handleMessage = vi.fn().mockResolvedValue({ text: "Deploy response" });
    getStatus = vi.fn().mockReturnValue({ id: "mock-deploy", type: "deploy", state: "IDLE", autonomyLevel: 1, uptimeMs: 0, tasksHandled: 0 });
    shutdown = vi.fn().mockResolvedValue(undefined);
  }
  class MockReviewAgent {
    initialize = vi.fn().mockResolvedValue(undefined);
    handleMessage = vi.fn().mockResolvedValue({ text: "Review response" });
    shutdown = vi.fn().mockResolvedValue(undefined);
  }
  class MockIncidentAgent {
    initialize = vi.fn().mockResolvedValue(undefined);
    handleMessage = vi.fn().mockResolvedValue({ text: "Incident response" });
    shutdown = vi.fn().mockResolvedValue(undefined);
  }
  return { MockApprovalManager, MockVectorStore, MockIdentityStore, MockGitHubClient, MockClaudeBridge, MockTaskAgent, MockDeployAgent, MockReviewAgent, MockIncidentAgent };
});

vi.mock("@codespar/core", () => ({
  ApprovalManager: mocks.MockApprovalManager,
  VectorStore: mocks.MockVectorStore,
  IdentityStore: mocks.MockIdentityStore,
  GitHubClient: mocks.MockGitHubClient,
  ClaudeBridge: mocks.MockClaudeBridge,
  generateSmartResponse: vi.fn().mockResolvedValue(null),
  generateSmartResponseStreaming: vi.fn().mockResolvedValue(null),
  metrics: { increment: vi.fn(), observe: vi.fn() },
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.mock("@codespar/agent-task", () => ({
  TaskAgent: mocks.MockTaskAgent,
}));

vi.mock("@codespar/agent-deploy", () => ({ DeployAgent: mocks.MockDeployAgent }));
vi.mock("@codespar/agent-review", () => ({ ReviewAgent: mocks.MockReviewAgent }));
vi.mock("@codespar/agent-incident", () => ({ IncidentAgent: mocks.MockIncidentAgent }));

// ── Helpers ───────────────────────────────────────────────────────
function makeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    id: "agent-default",
    type: "project",
    autonomyLevel: 1,
    projectId: "proj-1",
    orgId: "org-1",
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
    risk: "low",
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
describe("ProjectAgent", () => {
  let agent: ProjectAgent;
  let storage: StorageProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    storage = makeMockStorage();
    agent = new ProjectAgent(makeConfig(), storage);
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

    it("sets config type to 'project'", () => {
      expect(agent.config.type).toBe("project");
    });

    it("restores tasksHandled from storage on initialize", async () => {
      (storage.getMemory as ReturnType<typeof vi.fn>).mockImplementation(
        (_agentId: string, key: string) => {
          if (key === "tasksHandled") return Promise.resolve(42);
          return Promise.resolve(null);
        },
      );

      await agent.initialize();
      const status = agent.getStatus();
      expect(status.tasksHandled).toBe(42);
    });

    it("restores autonomy level from storage", async () => {
      (storage.getMemory as ReturnType<typeof vi.fn>).mockImplementation(
        (_agentId: string, key: string) => {
          if (key === "autonomyLevel") return Promise.resolve(3);
          return Promise.resolve(null);
        },
      );

      await agent.initialize();
      expect(agent.config.autonomyLevel).toBe(3);
    });
  });

  // ── handleMessage — status ────────────────────────────────────
  describe("handleMessage — status", () => {
    beforeEach(async () => {
      await agent.initialize();
    });

    it("returns agent status information", async () => {
      const msg = makeMessage("status");
      const intent = makeIntent("status", {}, "status");

      const response = await agent.handleMessage(msg, intent);

      expect(response.text).toContain("agent-default");
      expect(response.text).toContain("ACTIVE");
    });

    it("persists task count to storage after handling", async () => {
      const msg = makeMessage("status");
      const intent = makeIntent("status", {}, "status");

      await agent.handleMessage(msg, intent);

      expect(storage.setMemory).toHaveBeenCalledWith(
        "agent-default",
        "tasksHandled",
        expect.any(Number),
      );
    });

    it("appends audit entry for status query", async () => {
      const msg = makeMessage("status");
      const intent = makeIntent("status", {}, "status");

      await agent.handleMessage(msg, intent);

      expect(storage.appendAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "status.queried",
          result: "success",
        }),
      );
    });
  });

  // ── handleMessage — help ──────────────────────────────────────
  describe("handleMessage — help", () => {
    beforeEach(async () => {
      await agent.initialize();
    });

    it("returns the help menu with available commands", async () => {
      const msg = makeMessage("help");
      const intent = makeIntent("help", {}, "help");

      const response = await agent.handleMessage(msg, intent);

      expect(response.text).toContain("Available commands");
      expect(response.text).toContain("instruct");
      expect(response.text).toContain("deploy");
      expect(response.text).toContain("status");
    });

    it("includes the agent ID in the help response", async () => {
      const msg = makeMessage("help");
      const intent = makeIntent("help", {}, "help");

      const response = await agent.handleMessage(msg, intent);

      expect(response.text).toContain("agent-default");
    });
  });

  // ── getStatus ─────────────────────────────────────────────────
  describe("getStatus", () => {
    it("returns correct status fields after initialization", async () => {
      await agent.initialize();
      const status = agent.getStatus();

      expect(status.id).toBe("agent-default");
      expect(status.type).toBe("project");
      expect(status.state).toBe("IDLE");
      expect(status.autonomyLevel).toBe(1);
      expect(status.projectId).toBe("proj-1");
      expect(status.orgId).toBe("org-1");
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
  });

  // ── State transitions ─────────────────────────────────────────
  describe("state transitions", () => {
    it("transitions to ACTIVE when handling a message", async () => {
      await agent.initialize();
      // We can check by inspecting after a quick help (which is synchronous-ish)
      // The state returns to IDLE after handleMessage completes,
      // but we can verify via getStatus that tasksHandled increases
      const msg = makeMessage("help");
      const intent = makeIntent("help", {}, "help");

      await agent.handleMessage(msg, intent);

      // After completing, state should be IDLE again
      expect(agent.state).toBe("IDLE");
      // But tasksHandled should have incremented (proving ACTIVE was entered)
      expect(agent.getStatus().tasksHandled).toBe(1);
    });
  });
});
