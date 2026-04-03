import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DeployHealthMonitor } from "../health-monitor.js";
import type { HealthCheckResult } from "../health-monitor.js";
import type { StorageProvider, AuditEntry } from "../../storage/types.js";

// ── Helpers ──────────────────────────────────────────────────────────

function createMockStorage(entries: AuditEntry[] = []): StorageProvider {
  return {
    queryAudit: vi.fn().mockResolvedValue({ entries, total: entries.length }),
    appendAudit: vi.fn().mockResolvedValue({ id: "1", timestamp: new Date() }),
    getMemory: vi.fn(),
    setMemory: vi.fn(),
    getProjectConfig: vi.fn(),
    setProjectConfig: vi.fn(),
    deleteProjectConfig: vi.fn(),
    getProjectsList: vi.fn().mockResolvedValue([]),
    addProject: vi.fn(),
    removeProject: vi.fn(),
    addSubscriber: vi.fn(),
    getSubscribers: vi.fn().mockResolvedValue([]),
    removeSubscriber: vi.fn(),
    saveSlackInstallation: vi.fn(),
    getSlackInstallation: vi.fn(),
    removeSlackInstallation: vi.fn(),
    saveAgentState: vi.fn(),
    getAgentState: vi.fn(),
    getAllAgentStates: vi.fn().mockResolvedValue([]),
    saveChannelConfig: vi.fn(),
    getChannelConfig: vi.fn(),
  } as unknown as StorageProvider;
}

function makeAuditEntry(overrides: Partial<AuditEntry> & { metadata?: Record<string, unknown> }): AuditEntry {
  return {
    id: Math.random().toString(36).slice(2),
    timestamp: new Date(),
    actorType: "system",
    actorId: "sentry",
    action: "error.error",
    result: "error",
    metadata: { project: "my-app" },
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("DeployHealthMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("completes after monitorDurationMs and reports healthy", async () => {
    const storage = createMockStorage([]);
    const monitor = new DeployHealthMonitor(storage);

    const onComplete = vi.fn();
    const resultPromise = monitor.monitor(
      "my-app",
      "deploy-1",
      { checkIntervalMs: 100, monitorDurationMs: 500, errorThreshold: 0.10, minSamples: 5 },
      undefined,
      onComplete,
    );

    // Advance past the full monitoring window
    await vi.advanceTimersByTimeAsync(600);

    const result = await resultPromise;
    expect(result.healthy).toBe(true);
    expect(result.checkCount).toBeGreaterThan(0);
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ healthy: true }));
  });

  it("calls onUnhealthy when error rate exceeds threshold for 2 consecutive checks", async () => {
    // 8 errors out of 10 entries → 80% error rate
    const errorEntries: AuditEntry[] = [];
    for (let i = 0; i < 8; i++) {
      errorEntries.push(makeAuditEntry({ result: "error", actorId: "sentry" }));
    }
    for (let i = 0; i < 2; i++) {
      errorEntries.push(makeAuditEntry({ result: "success", actorId: "vercel", action: "deploy.READY" }));
    }

    const storage = createMockStorage(errorEntries);
    const monitor = new DeployHealthMonitor(storage);

    const onUnhealthy = vi.fn().mockResolvedValue(undefined);
    const onComplete = vi.fn();

    const resultPromise = monitor.monitor(
      "my-app",
      "deploy-2",
      { checkIntervalMs: 100, monitorDurationMs: 5000, errorThreshold: 0.10, minSamples: 5 },
      onUnhealthy,
      onComplete,
    );

    // First check at 100ms
    await vi.advanceTimersByTimeAsync(110);
    // Second check at 200ms — 2 consecutive → unhealthy
    await vi.advanceTimersByTimeAsync(110);

    const result = await resultPromise;
    expect(result.healthy).toBe(false);
    expect(result.errorRate).toBeGreaterThan(0.10);
    expect(onUnhealthy).toHaveBeenCalledOnce();
    // onComplete should NOT be called when unhealthy triggers early
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("does not trigger onUnhealthy on a single spike (requires 2 consecutive)", async () => {
    let callCount = 0;

    // First call: high error rate. Second call: no errors.
    const highErrorEntries: AuditEntry[] = [];
    for (let i = 0; i < 8; i++) {
      highErrorEntries.push(makeAuditEntry({ result: "error", actorId: "sentry" }));
    }
    for (let i = 0; i < 2; i++) {
      highErrorEntries.push(makeAuditEntry({ result: "success", actorId: "vercel", action: "deploy.READY" }));
    }

    const noErrorEntries: AuditEntry[] = [];
    for (let i = 0; i < 10; i++) {
      noErrorEntries.push(makeAuditEntry({ result: "success", actorId: "vercel", action: "deploy.READY" }));
    }

    const storage = createMockStorage([]);
    (storage.queryAudit as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callCount++;
      // Odd calls: high error. Even calls: no error. Alternating prevents consecutive.
      if (callCount % 2 === 1) {
        return { entries: highErrorEntries, total: highErrorEntries.length };
      }
      return { entries: noErrorEntries, total: noErrorEntries.length };
    });

    const monitor = new DeployHealthMonitor(storage);
    const onUnhealthy = vi.fn().mockResolvedValue(undefined);
    const onComplete = vi.fn();

    const resultPromise = monitor.monitor(
      "my-app",
      "deploy-3",
      { checkIntervalMs: 100, monitorDurationMs: 500, errorThreshold: 0.10, minSamples: 5 },
      onUnhealthy,
      onComplete,
    );

    // Run the full duration
    await vi.advanceTimersByTimeAsync(600);

    const result = await resultPromise;
    // Should complete healthy because errors never appear twice consecutively
    expect(result.healthy).toBe(true);
    expect(onUnhealthy).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("cancel stops monitoring without calling callbacks", async () => {
    const storage = createMockStorage([]);
    const monitor = new DeployHealthMonitor(storage);

    const onUnhealthy = vi.fn().mockResolvedValue(undefined);
    const onComplete = vi.fn();

    // Start monitoring but don't await — we want to cancel mid-flight
    const resultPromise = monitor.monitor(
      "my-app",
      "deploy-4",
      { checkIntervalMs: 100, monitorDurationMs: 5000, errorThreshold: 0.10, minSamples: 5 },
      onUnhealthy,
      onComplete,
    );

    // Let one check happen
    await vi.advanceTimersByTimeAsync(150);

    // Verify it is active
    expect(monitor.getActive()).toHaveLength(1);
    expect(monitor.getActive()[0].deployId).toBe("deploy-4");

    // Cancel
    monitor.cancel("deploy-4");
    expect(monitor.getActive()).toHaveLength(0);

    // Advance past duration — nothing should fire
    await vi.advanceTimersByTimeAsync(6000);

    expect(onUnhealthy).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("onComplete receives final stats with correct check count", async () => {
    const storage = createMockStorage([]);
    const monitor = new DeployHealthMonitor(storage);

    const onComplete = vi.fn();
    const resultPromise = monitor.monitor(
      "my-app",
      "deploy-5",
      { checkIntervalMs: 100, monitorDurationMs: 350, errorThreshold: 0.10, minSamples: 5 },
      undefined,
      onComplete,
    );

    // Checks at 100, 200, 300 → 3 checks, then timeout at 350
    await vi.advanceTimersByTimeAsync(400);

    const result = await resultPromise;
    expect(result.checkCount).toBe(3);
    expect(result.healthy).toBe(true);
    expect(result.duration).toMatch(/^\d+s$|^\d+m \d+s$/);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("getActive returns active monitors", async () => {
    const storage = createMockStorage([]);
    const monitor = new DeployHealthMonitor(storage);

    expect(monitor.getActive()).toHaveLength(0);

    // Start two monitors
    monitor.monitor("app-1", "d-1", { checkIntervalMs: 100, monitorDurationMs: 5000, errorThreshold: 0.1, minSamples: 5 });
    monitor.monitor("app-2", "d-2", { checkIntervalMs: 100, monitorDurationMs: 5000, errorThreshold: 0.1, minSamples: 5 });

    const active = monitor.getActive();
    expect(active).toHaveLength(2);
    expect(active.map((a) => a.deployId).sort()).toEqual(["d-1", "d-2"]);

    // Cleanup
    monitor.cancel("d-1");
    monitor.cancel("d-2");
  });

  it("works without storage (returns healthy with 0 requests)", async () => {
    const monitor = new DeployHealthMonitor();

    const resultPromise = monitor.monitor(
      "my-app",
      "deploy-no-storage",
      { checkIntervalMs: 100, monitorDurationMs: 300, errorThreshold: 0.10, minSamples: 5 },
    );

    await vi.advanceTimersByTimeAsync(400);

    const result = await resultPromise;
    expect(result.healthy).toBe(true);
    expect(result.totalRequests).toBe(0);
  });

  it("ignores errors below minSamples threshold", async () => {
    // 2 errors out of 3 entries (67% error rate) but below minSamples=5
    const entries: AuditEntry[] = [
      makeAuditEntry({ result: "error", actorId: "sentry" }),
      makeAuditEntry({ result: "error", actorId: "sentry" }),
      makeAuditEntry({ result: "success", actorId: "vercel", action: "deploy.READY" }),
    ];

    const storage = createMockStorage(entries);
    const monitor = new DeployHealthMonitor(storage);
    const onUnhealthy = vi.fn().mockResolvedValue(undefined);

    const resultPromise = monitor.monitor(
      "my-app",
      "deploy-min-samples",
      { checkIntervalMs: 100, monitorDurationMs: 500, errorThreshold: 0.10, minSamples: 5 },
      onUnhealthy,
    );

    await vi.advanceTimersByTimeAsync(600);

    const result = await resultPromise;
    expect(result.healthy).toBe(true);
    expect(onUnhealthy).not.toHaveBeenCalled();
  });
});
