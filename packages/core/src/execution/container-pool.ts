/**
 * Container Pool — manages a pool of pre-created Docker containers
 * for fast task execution startup.
 *
 * Containers in the pool are created in a "paused" state (actually just created
 * but not started), ready to be acquired and used for command execution.
 *
 * On shutdown, drain() destroys all pooled containers.
 */

import Docker from "dockerode";
import { DEFAULT_SANDBOX_CONFIG } from "./sandbox.js";
import type { SandboxConfig } from "./sandbox.js";

export interface PoolStats {
  /** Containers available in the pool, ready to be acquired */
  available: number;
  /** Containers currently in use */
  active: number;
  /** Total containers managed (available + active) */
  total: number;
}

export class ContainerPool {
  private available: Docker.Container[] = [];
  private active: Set<string> = new Set();
  private docker: Docker;
  private maxSize: number;
  private config: SandboxConfig;

  constructor(maxSize = 3, config?: Partial<SandboxConfig>) {
    this.docker = new Docker();
    this.maxSize = maxSize;
    this.config = { ...DEFAULT_SANDBOX_CONFIG, ...config };
  }

  /**
   * Pre-create containers to warm up the pool.
   * Creates up to `count` containers (capped at maxSize - current total).
   */
  async warmUp(count?: number): Promise<void> {
    const toCreate = Math.min(
      count ?? this.maxSize,
      this.maxSize - this.available.length - this.active.size,
    );

    const promises: Promise<void>[] = [];
    for (let i = 0; i < toCreate; i++) {
      promises.push(
        this.createPooledContainer().then((c) => {
          this.available.push(c);
        }),
      );
    }
    await Promise.allSettled(promises);
  }

  /**
   * Acquire a container from the pool. If none available, creates one on demand
   * (even if it exceeds maxSize — we never block callers).
   */
  async acquire(): Promise<Docker.Container> {
    let container = this.available.pop();
    if (!container) {
      container = await this.createPooledContainer();
    }
    this.active.add(container.id);
    return container;
  }

  /**
   * Release a container back to the pool. If the pool is full, the container
   * is destroyed instead.
   */
  async release(container: Docker.Container): Promise<void> {
    this.active.delete(container.id);

    if (this.available.length < this.maxSize) {
      // Container may have been started — stop and re-create is safer
      // than trying to reset state. Remove and create a fresh one.
      await this.destroyContainer(container);
      try {
        const fresh = await this.createPooledContainer();
        this.available.push(fresh);
      } catch {
        /* pool replenishment is best-effort */
      }
    } else {
      await this.destroyContainer(container);
    }
  }

  /** Destroy all containers in the pool (for graceful shutdown). */
  async drain(): Promise<void> {
    const all = [...this.available];
    this.available = [];

    // Also try to clean up any active containers we know about
    for (const id of this.active) {
      all.push(this.docker.getContainer(id));
    }
    this.active.clear();

    await Promise.allSettled(all.map((c) => this.destroyContainer(c)));
  }

  /** Current pool statistics. */
  get stats(): PoolStats {
    return {
      available: this.available.length,
      active: this.active.size,
      total: this.available.length + this.active.size,
    };
  }

  // ── Private helpers ─────────────────────────────────────────────

  private async createPooledContainer(): Promise<Docker.Container> {
    const cfg = this.config;
    const envArray = Object.entries(cfg.env).map(([k, v]) => `${k}=${v}`);

    const memoryBytes = this.parseMemoryLimit(cfg.memoryLimit);
    const nanoCpus = Math.round(parseFloat(cfg.cpuLimit) * 1e9);

    return this.docker.createContainer({
      Image: cfg.image,
      Cmd: ["sleep", "infinity"], // Keep alive until we exec into it
      WorkingDir: cfg.workDir,
      Env: envArray,
      Labels: { "codespar.sandbox": "true", "codespar.pool": "true" },
      HostConfig: {
        Memory: memoryBytes,
        NanoCpus: nanoCpus,
        NetworkMode: cfg.networkEnabled ? "bridge" : "none",
        Tmpfs: { "/tmp": "rw,noexec,nosuid,size=64m" },
        AutoRemove: false,
      },
      NetworkDisabled: !cfg.networkEnabled,
    });
  }

  private async destroyContainer(container: Docker.Container): Promise<void> {
    try {
      await container.stop({ t: 2 });
    } catch {
      /* may already be stopped or not started */
    }
    try {
      await container.remove({ force: true });
    } catch {
      /* best-effort cleanup */
    }
  }

  private parseMemoryLimit(limit: string): number {
    const match = limit.match(/^(\d+)(m|g|k)?$/i);
    if (!match) return 512 * 1024 * 1024;
    const value = parseInt(match[1], 10);
    const unit = (match[2] ?? "m").toLowerCase();
    const multipliers: Record<string, number> = {
      k: 1024,
      m: 1024 * 1024,
      g: 1024 * 1024 * 1024,
    };
    return value * (multipliers[unit] ?? 1024 * 1024);
  }
}
