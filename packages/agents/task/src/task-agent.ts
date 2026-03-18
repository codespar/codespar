/**
 * Task Agent — Ephemeral agent that executes coding tasks.
 *
 * Uses ClaudeBridge to execute instructions via Claude Code CLI.
 * Falls back to simulation if Claude CLI is not available.
 */

import type {
  Agent,
  AgentConfig,
  AgentState,
  AgentStatus,
  NormalizedMessage,
  ChannelResponse,
  ParsedIntent,
} from "@codespar/core";
import { ClaudeBridge, type ExecutionResult } from "@codespar/core";

export interface TaskResult {
  taskId: string;
  instruction: string;
  status: "queued" | "running" | "completed" | "failed";
  output?: string;
  durationMs?: number;
  simulated?: boolean;
}

let taskCounter = 0;

function generateTaskId(): string {
  taskCounter++;
  return `task-${Date.now()}-${taskCounter}`;
}

export class TaskAgent implements Agent {
  readonly config: AgentConfig;
  private _state: AgentState = "INITIALIZING";
  private startedAt: Date = new Date();
  private tasksHandled: number = 0;
  private taskQueue: TaskResult[] = [];
  private executionHistory: TaskResult[] = [];
  private bridge: ClaudeBridge = new ClaudeBridge();
  private claudeAvailable: boolean = false;

  constructor(config: AgentConfig) {
    this.config = { ...config, type: "task" };
  }

  get state(): AgentState {
    return this._state;
  }

  async initialize(): Promise<void> {
    this._state = "INITIALIZING";
    this.startedAt = new Date();
    this.claudeAvailable = await this.bridge.isAvailable();
    if (this.claudeAvailable) {
      console.log(`[${this.config.id}] Claude Code CLI detected`);
    }
    this._state = "IDLE";
  }

  async handleMessage(
    message: NormalizedMessage,
    intent: ParsedIntent
  ): Promise<ChannelResponse> {
    switch (intent.type) {
      case "instruct":
        return this.executeTask(
          intent.params.instruction || intent.rawText,
          "instruct"
        );
      case "fix":
        return this.executeTask(
          `Fix: ${intent.params.issue || intent.rawText}`,
          "fix"
        );
      default:
        return {
          text: `[${this.config.id}] Task Agent only handles instruct and fix commands.`,
        };
    }
  }

  private async executeTask(
    instruction: string,
    type: "instruct" | "fix"
  ): Promise<ChannelResponse> {
    const taskId = generateTaskId();
    const task: TaskResult = { taskId, instruction, status: "queued" };
    this.taskQueue.push(task);

    this._state = "ACTIVE";
    task.status = "running";

    try {
      const workDir = process.env.CODESPAR_WORK_DIR || process.cwd();

      const result: ExecutionResult = await this.bridge.execute({
        taskId,
        instruction,
        workDir,
        timeout: 300_000,
      });

      task.status = result.status === "completed" ? "completed" : "failed";
      task.durationMs = result.durationMs;
      task.output = result.output;
      task.simulated = result.simulated;

      this.tasksHandled++;
      this.executionHistory.push({ ...task });
      this.taskQueue = this.taskQueue.filter((t) => t.taskId !== taskId);
      this._state = "IDLE";

      const duration = result.durationMs < 1000
        ? `${result.durationMs}ms`
        : `${(result.durationMs / 1000).toFixed(1)}s`;

      const mode = result.simulated ? " (simulated)" : "";

      return {
        text: [
          `[${this.config.id}] Task ${task.status}${mode}: ${taskId}`,
          `  Instruction: ${instruction}`,
          `  Status: ${task.status}`,
          `  Duration: ${duration}`,
          `  Output: ${(task.output || "").slice(0, 500)}`,
        ].join("\n"),
      };
    } catch (error) {
      task.status = "failed";
      task.output = error instanceof Error ? error.message : "Unknown error";
      this.executionHistory.push({ ...task });
      this.taskQueue = this.taskQueue.filter((t) => t.taskId !== taskId);
      this._state = "IDLE";

      return {
        text: [
          `[${this.config.id}] Task failed: ${taskId}`,
          `  Instruction: ${instruction}`,
          `  Error: ${task.output}`,
        ].join("\n"),
      };
    }
  }

  getTaskQueue(): TaskResult[] {
    return [...this.taskQueue];
  }

  getExecutionHistory(): TaskResult[] {
    return [...this.executionHistory];
  }

  getStatus(): AgentStatus {
    return {
      id: this.config.id,
      type: this.config.type,
      state: this._state,
      autonomyLevel: this.config.autonomyLevel,
      projectId: this.config.projectId,
      lastActiveAt: new Date(),
      uptimeMs: Date.now() - this.startedAt.getTime(),
      tasksHandled: this.tasksHandled,
    };
  }

  async shutdown(): Promise<void> {
    this._state = "TERMINATED";
    this.taskQueue = [];
  }
}
