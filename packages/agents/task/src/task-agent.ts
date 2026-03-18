/**
 * Task Agent — Ephemeral agent that executes coding tasks.
 *
 * Responsibilities:
 * - Receives instructions from Project Agent (instruct/fix intents)
 * - Queues and executes tasks sequentially
 * - Reports execution results back
 *
 * MVP: Simulates execution with a delay and returns mock results.
 * Future: Will spawn Claude Code CLI in a Docker container.
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

export interface TaskResult {
  taskId: string;
  instruction: string;
  status: "queued" | "running" | "completed" | "failed";
  output?: string;
  durationMs?: number;
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

  constructor(config: AgentConfig) {
    this.config = {
      ...config,
      type: "task",
    };
  }

  get state(): AgentState {
    return this._state;
  }

  async initialize(): Promise<void> {
    this._state = "INITIALIZING";
    this.startedAt = new Date();
    this._state = "IDLE";
  }

  async handleMessage(
    message: NormalizedMessage,
    intent: ParsedIntent
  ): Promise<ChannelResponse> {
    switch (intent.type) {
      case "instruct":
        return this.handleInstruct(intent);

      case "fix":
        return this.handleFix(intent);

      default:
        return {
          text: `[${this.config.id}] Task Agent only handles instruct and fix commands.`,
        };
    }
  }

  private async handleInstruct(intent: ParsedIntent): Promise<ChannelResponse> {
    const instruction = intent.params.instruction || intent.rawText;
    return this.executeTask(instruction, "instruct");
  }

  private async handleFix(intent: ParsedIntent): Promise<ChannelResponse> {
    const issue = intent.params.issue || intent.rawText;
    const instruction = `Fix: ${issue}`;
    return this.executeTask(instruction, "fix");
  }

  /**
   * Queues a task, simulates execution, and returns the result.
   * MVP: uses a delay to simulate Claude Code execution.
   * Future: will spawn `claude-code` in a Docker container via child_process.
   */
  private async executeTask(
    instruction: string,
    type: "instruct" | "fix"
  ): Promise<ChannelResponse> {
    const taskId = generateTaskId();

    // Queue the task
    const task: TaskResult = {
      taskId,
      instruction,
      status: "queued",
    };
    this.taskQueue.push(task);

    // Transition to ACTIVE
    this._state = "ACTIVE";
    task.status = "running";

    const startTime = Date.now();

    try {
      // Simulate execution (MVP: delay + mock result)
      await this.simulateExecution(instruction);

      const durationMs = Date.now() - startTime;
      task.status = "completed";
      task.durationMs = durationMs;
      task.output = this.generateMockOutput(instruction, type);

      this.tasksHandled++;
      this.executionHistory.push({ ...task });
      this.removeFromQueue(taskId);

      this._state = "IDLE";

      return {
        text: [
          `[${this.config.id}] Task completed: ${taskId}`,
          `  Instruction: ${instruction}`,
          `  Status: ${task.status}`,
          `  Duration: ${durationMs}ms`,
          `  Output: ${task.output}`,
        ].join("\n"),
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      task.status = "failed";
      task.durationMs = durationMs;
      task.output = error instanceof Error ? error.message : "Unknown error";

      this.executionHistory.push({ ...task });
      this.removeFromQueue(taskId);

      this._state = "IDLE";

      return {
        text: [
          `[${this.config.id}] Task failed: ${taskId}`,
          `  Instruction: ${instruction}`,
          `  Error: ${task.output}`,
          `  Duration: ${durationMs}ms`,
        ].join("\n"),
      };
    }
  }

  /**
   * Simulates Claude Code execution with a short delay.
   * MVP placeholder — will be replaced by child_process.spawn in Phase 2.
   */
  private simulateExecution(instruction: string): Promise<void> {
    const delayMs = 100 + Math.floor(Math.random() * 200);
    return new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  /**
   * Generates a mock output based on the instruction type.
   * MVP placeholder — will be replaced by real Claude Code output.
   */
  private generateMockOutput(instruction: string, type: "instruct" | "fix"): string {
    if (type === "fix") {
      return `Analyzed and applied fix for: "${instruction}". Changes staged for review.`;
    }
    return `Executed instruction: "${instruction}". Changes applied successfully.`;
  }

  private removeFromQueue(taskId: string): void {
    this.taskQueue = this.taskQueue.filter((t) => t.taskId !== taskId);
  }

  /** Returns the current task queue */
  getTaskQueue(): TaskResult[] {
    return [...this.taskQueue];
  }

  /** Returns completed/failed task history */
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
