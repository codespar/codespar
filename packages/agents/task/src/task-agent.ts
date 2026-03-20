/**
 * Task Agent — Ephemeral agent that executes coding tasks.
 *
 * Uses ClaudeBridge to execute instructions via Anthropic Messages API.
 * Falls back to simulation if ANTHROPIC_API_KEY is not set.
 */

import type {
  Agent,
  AgentConfig,
  AgentState,
  AgentStatus,
  NormalizedMessage,
  ChannelResponse,
  ParsedIntent,
  StorageProvider,
} from "@codespar/core";
import { ClaudeBridge, GitHubClient, type ExecutionResult } from "@codespar/core";

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
  private storage: StorageProvider | null;

  constructor(config: AgentConfig, storage?: StorageProvider) {
    this.config = { ...config, type: "task" };
    this.storage = storage ?? null;
  }

  get state(): AgentState {
    return this._state;
  }

  async initialize(): Promise<void> {
    this._state = "INITIALIZING";
    this.startedAt = new Date();
    this.claudeAvailable = await this.bridge.isAvailable();
    if (this.claudeAvailable) {
      console.log(`[${this.config.id}] Anthropic API available`);
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

      // When a linked repo exists and GitHub is configured, use repo-aware execution
      // which reads actual code, sends context to Claude, and creates PRs.
      let result: ExecutionResult;

      // Try multiple keys to find the project config (agentId or projectId)
      let projectConfig = null;
      if (this.storage) {
        // The Project Agent stores config under its own ID (e.g., "agent-default")
        // Extract parent agent ID from task agent ID (e.g., "agent-default-task-1" → "agent-default")
        const parentAgentId = this.config.id.replace(/-task-\d+$/, "");
        projectConfig = await this.storage.getProjectConfig(parentAgentId);
        if (!projectConfig && this.config.projectId) {
          projectConfig = await this.storage.getProjectConfig(this.config.projectId);
        }
        console.log(`[${this.config.id}] Project config lookup: parentAgent=${parentAgentId}, found=${!!projectConfig}${projectConfig ? ` repo=${projectConfig.repoOwner}/${projectConfig.repoName}` : ""}`);
      }
      const github = new GitHubClient();
      console.log(`[${this.config.id}] GitHub configured: ${github.isConfigured()}, hasProjectConfig: ${!!projectConfig}`);

      if (projectConfig && github.isConfigured()) {
        result = await this.bridge.executeWithRepo({
          taskId,
          instruction,
          workDir,
          projectContext: this.config.projectId || undefined,
          repoOwner: projectConfig.repoOwner,
          repoName: projectConfig.repoName,
          timeout: 120_000,
        });
      } else {
        result = await this.bridge.execute({
          taskId,
          instruction,
          workDir,
          projectContext: this.config.projectId || undefined,
          timeout: 120_000,
        });
      }

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

      // For real (non-simulated) responses, format cleanly with full output
      if (!result.simulated) {
        return {
          text: [
            `[${this.config.id}] Task ${result.status}: ${taskId}`,
            `  Instruction: ${instruction}`,
            `  Duration: ${duration}`,
            "",
            result.output,
          ].join("\n"),
        };
      }

      return {
        text: [
          `[${this.config.id}] Task ${task.status} (simulated): ${taskId}`,
          `  Instruction: ${instruction}`,
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
