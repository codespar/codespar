/**
 * Docker Execution Sandbox — runs commands in isolated Docker containers.
 *
 * Implements the ExecutionSandbox interface defined in sandbox.ts.
 * Provides container-level isolation with memory/CPU limits, network control,
 * tmpfs for /tmp, and automatic cleanup after each execution.
 */

import Docker from "dockerode";
import type { ExecutionSandbox, SandboxConfig, SandboxResult } from "./sandbox.js";
import { DEFAULT_SANDBOX_CONFIG } from "./sandbox.js";

export class DockerSandbox implements ExecutionSandbox {
  private docker: Docker;
  private config: SandboxConfig;

  constructor(config?: Partial<SandboxConfig>) {
    this.docker = new Docker();
    this.config = { ...DEFAULT_SANDBOX_CONFIG, ...config };
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  async execute(command: string, config?: Partial<SandboxConfig>): Promise<SandboxResult> {
    const cfg = { ...this.config, ...config };
    const start = Date.now();
    let container: Docker.Container | undefined;

    try {
      container = await this.createContainer(cfg, ["sh", "-c", command]);
      return await this.runContainer(container, cfg.timeoutMs, start);
    } catch (err) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        timedOut: false,
      };
    } finally {
      if (container) {
        await this.removeContainer(container);
      }
    }
  }

  async executeScript(
    script: string,
    language: string,
    config?: Partial<SandboxConfig>,
  ): Promise<SandboxResult> {
    const interpreters: Record<string, string> = {
      javascript: "node -e",
      typescript: "npx tsx -e",
      python: "python3 -c",
      sh: "sh -c",
      bash: "bash -c",
    };
    const interpreter = interpreters[language] ?? "sh -c";
    // Escape single quotes in the script for safe shell embedding
    const escaped = script.replace(/'/g, "'\\''");
    return this.execute(`${interpreter} '${escaped}'`, config);
  }

  async cleanup(): Promise<void> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: ["codespar.sandbox=true"] },
    });
    await Promise.allSettled(
      containers.map(async (info) => {
        const c = this.docker.getContainer(info.Id);
        try {
          await c.stop({ t: 2 });
        } catch {
          /* already stopped */
        }
        await c.remove({ force: true });
      }),
    );
  }

  // ── Private helpers ─────────────────────────────────────────────

  private async createContainer(
    cfg: SandboxConfig,
    cmd: string[],
  ): Promise<Docker.Container> {
    const binds: string[] = [];
    for (const mount of cfg.mounts) {
      const flag = mount.readOnly ? "ro" : "rw";
      binds.push(`${mount.hostPath}:${mount.containerPath}:${flag}`);
    }

    const memoryBytes = this.parseMemoryLimit(cfg.memoryLimit);
    const nanoCpus = this.parseCpuLimit(cfg.cpuLimit);

    const envArray = Object.entries(cfg.env).map(([k, v]) => `${k}=${v}`);

    const container = await this.docker.createContainer({
      Image: cfg.image,
      Cmd: cmd,
      WorkingDir: cfg.workDir,
      Env: envArray,
      Labels: { "codespar.sandbox": "true" },
      HostConfig: {
        Binds: binds.length > 0 ? binds : undefined,
        Memory: memoryBytes,
        NanoCpus: nanoCpus,
        NetworkMode: cfg.networkEnabled ? "bridge" : "none",
        Tmpfs: { "/tmp": "rw,noexec,nosuid,size=64m" },
        AutoRemove: false,
      },
      NetworkDisabled: !cfg.networkEnabled,
    });

    return container;
  }

  private async runContainer(
    container: Docker.Container,
    timeoutMs: number,
    startTime: number,
  ): Promise<SandboxResult> {
    let timedOut = false;

    // Attach to capture stdout/stderr
    const stream = await container.attach({
      stream: true,
      stdout: true,
      stderr: true,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    // Demux Docker multiplexed stream
    const stdout = { write: (chunk: Buffer) => stdoutChunks.push(chunk) } as NodeJS.WritableStream;
    const stderr = { write: (chunk: Buffer) => stderrChunks.push(chunk) } as NodeJS.WritableStream;
    container.modem.demuxStream(stream, stdout, stderr);

    await container.start();

    // Race between container completion and timeout
    const timeoutPromise = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), timeoutMs),
    );
    const waitPromise = container.wait();

    const result = await Promise.race([waitPromise, timeoutPromise]);

    if (result === "timeout") {
      timedOut = true;
      try {
        await container.kill();
      } catch {
        /* container may have already exited */
      }
    }

    const exitCode = timedOut
      ? 137
      : typeof result === "object" && "StatusCode" in result
        ? result.StatusCode
        : 1;

    return {
      exitCode,
      stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
      stderr: Buffer.concat(stderrChunks).toString("utf-8"),
      durationMs: Date.now() - startTime,
      timedOut,
    };
  }

  private async removeContainer(container: Docker.Container): Promise<void> {
    try {
      await container.remove({ force: true });
    } catch {
      /* best-effort cleanup */
    }
  }

  /** Parse memory limit string like "512m" or "1g" to bytes */
  private parseMemoryLimit(limit: string): number {
    const match = limit.match(/^(\d+)(m|g|k)?$/i);
    if (!match) return 512 * 1024 * 1024; // default 512MB
    const value = parseInt(match[1], 10);
    const unit = (match[2] ?? "m").toLowerCase();
    const multipliers: Record<string, number> = {
      k: 1024,
      m: 1024 * 1024,
      g: 1024 * 1024 * 1024,
    };
    return value * (multipliers[unit] ?? 1024 * 1024);
  }

  /** Parse CPU limit string like "1.0" to nanoseconds (Docker NanoCpus) */
  private parseCpuLimit(limit: string): number {
    return Math.round(parseFloat(limit) * 1e9);
  }
}
