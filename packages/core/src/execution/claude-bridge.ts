/**
 * Claude Code Bridge — Executes instructions via Claude Code CLI.
 *
 * Spawns `claude --print --dangerously-skip-permissions "instruction"`
 * as a child process. Falls back to simulation if CLI not available.
 *
 * MVP: runs on host. Future: runs in isolated Docker container.
 */

import { spawn } from "node:child_process";

export interface ExecutionRequest {
  taskId: string;
  instruction: string;
  workDir: string;
  timeout?: number;
  allowedTools?: string[];
  blockedPatterns?: string[];
}

export interface ExecutionResult {
  taskId: string;
  status: "completed" | "failed" | "timeout";
  output: string;
  durationMs: number;
  exitCode: number | null;
  simulated: boolean;
}

export class ClaudeBridge {
  private available: boolean | null = null;

  /** Check if Claude Code CLI is installed. */
  async isAvailable(): Promise<boolean> {
    if (this.available !== null) return this.available;

    this.available = await new Promise<boolean>((resolve) => {
      const proc = spawn("claude", ["--version"], { timeout: 5000 });
      proc.on("close", (code) => resolve(code === 0));
      proc.on("error", () => resolve(false));
    });

    return this.available;
  }

  /** Execute an instruction. Uses Claude CLI if available, otherwise simulates. */
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const canRun = await this.isAvailable();

    if (!canRun) {
      return this.simulate(request);
    }

    return this.executeReal(request);
  }

  private async executeReal(request: ExecutionRequest): Promise<ExecutionResult> {
    const startTime = Date.now();
    const timeout = request.timeout ?? 300_000;

    return new Promise((resolve) => {
      const proc = spawn(
        "claude",
        ["--print", "--dangerously-skip-permissions", request.instruction],
        {
          cwd: request.workDir,
          timeout,
          env: { ...process.env, CI: "true" },
        }
      );

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        resolve({
          taskId: request.taskId,
          status: code === 0 ? "completed" : "failed",
          output: (stdout || stderr || "(no output)").slice(0, 2000),
          durationMs: Date.now() - startTime,
          exitCode: code,
          simulated: false,
        });
      });

      proc.on("error", (err) => {
        resolve({
          taskId: request.taskId,
          status: "failed",
          output: `Execution error: ${err.message}`,
          durationMs: Date.now() - startTime,
          exitCode: null,
          simulated: false,
        });
      });
    });
  }

  private async simulate(request: ExecutionRequest): Promise<ExecutionResult> {
    const startTime = Date.now();
    // Simulate a small delay
    await new Promise((r) => setTimeout(r, 100 + Math.random() * 200));

    return {
      taskId: request.taskId,
      status: "completed",
      output: `[simulated] Claude CLI not found. Would execute: "${request.instruction}"`,
      durationMs: Date.now() - startTime,
      exitCode: null,
      simulated: true,
    };
  }
}
