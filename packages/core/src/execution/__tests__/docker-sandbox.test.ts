import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock dockerode before any imports ─────────────────────────────
const mockPing = vi.fn();
const mockCreateContainer = vi.fn();
const mockListContainers = vi.fn();

function MockDocker() {
  return {
    ping: mockPing,
    createContainer: mockCreateContainer,
    listContainers: mockListContainers,
    getContainer: vi.fn().mockReturnValue({
      stop: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    }),
  };
}

vi.mock("dockerode", () => {
  return { default: MockDocker };
});

import { DockerSandbox } from "../docker-sandbox.js";
import { ContainerPool } from "../container-pool.js";
import { DEFAULT_SANDBOX_CONFIG } from "../sandbox.js";

// ── Helper to create a mock container ─────────────────────────────
function makeMockContainer(overrides?: Partial<{ exitCode: number; stdout: string; stderr: string }>) {
  const cfg = { exitCode: 0, stdout: "ok\n", stderr: "", ...overrides };
  const stdoutChunks: Buffer[] = [Buffer.from(cfg.stdout)];
  const stderrChunks: Buffer[] = [Buffer.from(cfg.stderr)];

  return {
    id: `container-${Math.random().toString(36).slice(2, 8)}`,
    attach: vi.fn().mockResolvedValue({
      on: vi.fn(),
    }),
    start: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue({ StatusCode: cfg.exitCode }),
    kill: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    modem: {
      demuxStream: vi.fn((_stream: unknown, stdout: { write: (b: Buffer) => void }, stderr: { write: (b: Buffer) => void }) => {
        for (const chunk of stdoutChunks) stdout.write(chunk);
        for (const chunk of stderrChunks) stderr.write(chunk);
      }),
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe("DEFAULT_SANDBOX_CONFIG", () => {
  it("has expected default values", () => {
    expect(DEFAULT_SANDBOX_CONFIG.image).toBe("node:22-alpine");
    expect(DEFAULT_SANDBOX_CONFIG.workDir).toBe("/workspace");
    expect(DEFAULT_SANDBOX_CONFIG.timeoutMs).toBe(60_000);
    expect(DEFAULT_SANDBOX_CONFIG.memoryLimit).toBe("512m");
    expect(DEFAULT_SANDBOX_CONFIG.cpuLimit).toBe("1.0");
    expect(DEFAULT_SANDBOX_CONFIG.networkEnabled).toBe(false);
    expect(DEFAULT_SANDBOX_CONFIG.env).toEqual({});
    expect(DEFAULT_SANDBOX_CONFIG.mounts).toEqual([]);
  });
});

describe("DockerSandbox", () => {
  let sandbox: DockerSandbox;

  beforeEach(() => {
    vi.clearAllMocks();
    sandbox = new DockerSandbox();
  });

  describe("isAvailable", () => {
    it("returns true when Docker daemon responds to ping", async () => {
      mockPing.mockResolvedValue("OK");
      expect(await sandbox.isAvailable()).toBe(true);
    });

    it("returns false when Docker daemon is unreachable", async () => {
      mockPing.mockRejectedValue(new Error("connect ENOENT"));
      expect(await sandbox.isAvailable()).toBe(false);
    });
  });

  describe("execute", () => {
    it("returns SandboxResult with stdout, stderr, exitCode, durationMs", async () => {
      const container = makeMockContainer({ stdout: "hello\n", stderr: "", exitCode: 0 });
      mockCreateContainer.mockResolvedValue(container);

      const result = await sandbox.execute("echo hello");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("hello\n");
      expect(result.stderr).toBe("");
      expect(result.timedOut).toBe(false);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("returns non-zero exitCode on command failure", async () => {
      const container = makeMockContainer({ exitCode: 1, stderr: "not found" });
      mockCreateContainer.mockResolvedValue(container);

      const result = await sandbox.execute("unknown-cmd");

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("not found");
    });

    it("handles container creation errors gracefully", async () => {
      mockCreateContainer.mockRejectedValue(new Error("image not found"));

      const result = await sandbox.execute("echo test");

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("image not found");
      expect(result.timedOut).toBe(false);
    });

    it("always removes the container after execution", async () => {
      const container = makeMockContainer();
      mockCreateContainer.mockResolvedValue(container);

      await sandbox.execute("echo test");

      expect(container.remove).toHaveBeenCalledWith({ force: true });
    });

    it("removes the container even when execution fails", async () => {
      const container = makeMockContainer();
      container.start.mockRejectedValue(new Error("start failed"));
      mockCreateContainer.mockResolvedValue(container);

      await sandbox.execute("echo test");

      expect(container.remove).toHaveBeenCalledWith({ force: true });
    });
  });

  describe("timeout handling", () => {
    it("kills the container and returns timedOut=true when timeout expires", async () => {
      const container = makeMockContainer();
      // Make wait() hang forever (simulate a long-running command)
      container.wait.mockReturnValue(new Promise(() => {}));
      mockCreateContainer.mockResolvedValue(container);

      // Use a very short timeout
      const result = await sandbox.execute("sleep 9999", { timeoutMs: 50 });

      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBe(137);
      expect(container.kill).toHaveBeenCalled();
    });
  });

  describe("cleanup", () => {
    it("removes all containers with codespar.sandbox label", async () => {
      const mockStop = vi.fn().mockResolvedValue(undefined);
      const mockRemove = vi.fn().mockResolvedValue(undefined);
      mockListContainers.mockResolvedValue([
        { Id: "abc123" },
        { Id: "def456" },
      ]);

      // getContainer is mocked at module level to return stop/remove

      await sandbox.cleanup();

      expect(mockListContainers).toHaveBeenCalledWith({
        all: true,
        filters: { label: ["codespar.sandbox=true"] },
      });
    });
  });
});

describe("ContainerPool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("stats", () => {
    it("starts with empty stats", () => {
      const pool = new ContainerPool(3);
      expect(pool.stats).toEqual({ available: 0, active: 0, total: 0 });
    });
  });

  describe("warmUp", () => {
    it("pre-creates containers up to the requested count", async () => {
      const containers = [makeMockContainer(), makeMockContainer()];
      let idx = 0;
      mockCreateContainer.mockImplementation(() => Promise.resolve(containers[idx++]));

      const pool = new ContainerPool(5);
      await pool.warmUp(2);

      expect(pool.stats.available).toBe(2);
      expect(pool.stats.active).toBe(0);
      expect(pool.stats.total).toBe(2);
    });

    it("does not exceed maxSize", async () => {
      mockCreateContainer.mockImplementation(() => Promise.resolve(makeMockContainer()));

      const pool = new ContainerPool(2);
      await pool.warmUp(10);

      expect(pool.stats.available).toBe(2);
    });
  });

  describe("acquire / release", () => {
    it("acquires a container from the pool", async () => {
      const container = makeMockContainer();
      mockCreateContainer.mockResolvedValue(container);

      const pool = new ContainerPool(3);
      await pool.warmUp(1);

      const acquired = await pool.acquire();
      expect(acquired.id).toBe(container.id);
      expect(pool.stats.available).toBe(0);
      expect(pool.stats.active).toBe(1);
    });

    it("creates a container on demand when pool is empty", async () => {
      const container = makeMockContainer();
      mockCreateContainer.mockResolvedValue(container);

      const pool = new ContainerPool(3);
      const acquired = await pool.acquire();

      expect(acquired).toBeDefined();
      expect(pool.stats.active).toBe(1);
    });

    it("replenishes pool on release (creates a fresh container)", async () => {
      const c1 = makeMockContainer();
      const c2 = makeMockContainer();
      let idx = 0;
      const containers = [c1, c2];
      mockCreateContainer.mockImplementation(() => Promise.resolve(containers[idx++] ?? makeMockContainer()));

      const pool = new ContainerPool(3);
      const acquired = await pool.acquire();
      await pool.release(acquired);

      // After release: old container destroyed, fresh one created
      expect(pool.stats.active).toBe(0);
      expect(pool.stats.available).toBe(1);
    });
  });

  describe("drain", () => {
    it("destroys all pooled containers", async () => {
      const c1 = makeMockContainer();
      const c2 = makeMockContainer();
      let idx = 0;
      mockCreateContainer.mockImplementation(() => Promise.resolve([c1, c2][idx++]));

      const pool = new ContainerPool(5);
      await pool.warmUp(2);

      await pool.drain();

      expect(pool.stats).toEqual({ available: 0, active: 0, total: 0 });
      expect(c1.stop).toHaveBeenCalled();
      expect(c1.remove).toHaveBeenCalledWith({ force: true });
      expect(c2.stop).toHaveBeenCalled();
      expect(c2.remove).toHaveBeenCalledWith({ force: true });
    });
  });
});

describe("createSandbox factory", () => {
  it("returns DockerSandbox when Docker is available", async () => {
    mockPing.mockResolvedValue("OK");

    const { createSandbox } = await import("../index.js");
    const sandbox = await createSandbox();

    expect(sandbox).not.toBeNull();
  });

  it("returns null when Docker is unavailable", async () => {
    mockPing.mockRejectedValue(new Error("not found"));

    const { createSandbox } = await import("../index.js");
    const sandbox = await createSandbox();

    expect(sandbox).toBeNull();
  });
});
