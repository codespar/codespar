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
import { ClaudeBridge, GitHubClient, parseFileChanges, parseDiffChanges, type ExecutionResult, type ExecutionRequest } from "@codespar/core";

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
    // Extract image URLs from message attachments for visual context
    const imageUrls = message.attachments
      ?.filter((a) => a.type === "image" && a.url)
      .map((a) => ({ url: a.url, mimeType: a.mimeType }));

    // Extract progress callback from message metadata (web chat SSE)
    const onProgress = (message.metadata?.onProgress as ((e: unknown) => void)) || undefined;

    switch (intent.type) {
      case "instruct":
        return this.executeTask(
          intent.params.instruction || intent.rawText,
          "instruct",
          imageUrls,
          onProgress,
        );
      case "fix":
        return this.executeTask(
          `Fix: ${intent.params.issue || intent.rawText}`,
          "fix",
          imageUrls,
          onProgress,
        );
      default:
        return {
          text: `[${this.config.id}] Task Agent only handles instruct and fix commands.`,
        };
    }
  }

  private async executeTask(
    instruction: string,
    type: "instruct" | "fix",
    imageUrls?: Array<{ url: string; mimeType?: string }>,
    onProgress?: (event: unknown) => void,
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
      // Resolve per-org GitHub token (from OAuth) or fall back to env var
      let githubToken: string | undefined;
      if (this.storage) {
        const orgToken = await this.storage.getMemory("github-oauth", "token");
        if (orgToken && typeof orgToken === "string") {
          githubToken = orgToken;
        }
      }

      const github = new GitHubClient(githubToken);
      console.log(`[${this.config.id}] GitHub configured: ${github.isConfigured()}, hasProjectConfig: ${!!projectConfig}`);

      if (projectConfig && github.isConfigured()) {
        result = await this.bridge.executeWithRepo({
          taskId,
          instruction,
          workDir,
          projectContext: this.config.projectId || undefined,
          repoOwner: projectConfig.repoOwner,
          repoName: projectConfig.repoName,
          githubToken,
          timeout: 120_000,
          imageUrls,
          onProgress: onProgress as ExecutionRequest["onProgress"],
        });
      } else {
        result = await this.bridge.execute({
          taskId,
          instruction,
          workDir,
          projectContext: this.config.projectId || undefined,
          timeout: 120_000,
          imageUrls,
          onProgress: onProgress as ExecutionRequest["onProgress"],
        });
      }

      task.status = result.status === "completed" ? "completed" : "failed";
      task.durationMs = result.durationMs;
      task.output = result.output;
      task.simulated = result.simulated;

      // Post-execution: create a GitHub PR if the output contains code changes
      // and no PR was already created (executeWithRepo embeds PR URLs in output).
      let prUrl: string | undefined;
      if (
        result.status === "completed" &&
        !result.simulated &&
        result.output &&
        !result.output.includes("PR #") &&
        github.isConfigured() &&
        projectConfig
      ) {
        prUrl = await this.maybeCreatePR(
          github,
          projectConfig.repoOwner,
          projectConfig.repoName,
          instruction,
          taskId,
          result.output,
        );
      }

      this.tasksHandled++;
      this.executionHistory.push({ ...task });
      this.taskQueue = this.taskQueue.filter((t) => t.taskId !== taskId);
      this._state = "IDLE";

      const duration = result.durationMs < 1000
        ? `${result.durationMs}ms`
        : `${(result.durationMs / 1000).toFixed(1)}s`;

      const prSuffix = prUrl ? `\n\n✅ Pull request created: ${prUrl}` : "";

      // For real (non-simulated) responses, format cleanly with full output
      if (!result.simulated) {
        return {
          text: [
            `[${this.config.id}] Task ${result.status}: ${taskId}`,
            `  Instruction: ${instruction}`,
            `  Duration: ${duration}`,
            "",
            result.output,
          ].join("\n") + prSuffix,
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

  /**
   * Attempt to create a GitHub PR from code changes found in execution output.
   * Supports both ===DIFF:=== (search/replace) and ===FILE:=== (full file) formats.
   * Returns the PR URL on success, undefined if no changes or PR creation failed.
   */
  private async maybeCreatePR(
    github: GitHubClient,
    repoOwner: string,
    repoName: string,
    instruction: string,
    taskId: string,
    output: string,
  ): Promise<string | undefined> {
    try {
      // Try full-file format first (works without original file contents)
      let fileChanges = parseFileChanges(output);

      // Try diff format — requires reading original files from GitHub
      if (fileChanges.length === 0) {
        const diffRegex = /===DIFF:\s*(.+?)===\n/g;
        const referencedPaths = new Set<string>();
        let m;
        while ((m = diffRegex.exec(output)) !== null) {
          referencedPaths.add(m[1].trim());
        }

        if (referencedPaths.size > 0) {
          // Read original files so parseDiffChanges can apply search/replace
          const originals: Array<{ path: string; content: string; sha: string }> = [];
          for (const filePath of referencedPaths) {
            const file = await github.readFile(repoOwner, repoName, filePath);
            if (file) {
              originals.push({ path: filePath, content: file.content, sha: file.sha });
            }
          }
          if (originals.length > 0) {
            fileChanges = parseDiffChanges(output, originals);
          }
        }
      }

      if (fileChanges.length === 0) {
        return undefined;
      }

      // Create branch
      const shortDesc = instruction.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 30).toLowerCase();
      const branchName = `fix/${taskId.slice(0, 12)}-${shortDesc}`;
      const defaultBranch = await github.getDefaultBranch(repoOwner, repoName);
      const branchCreated = await github.createBranch(repoOwner, repoName, branchName, defaultBranch);

      if (!branchCreated) {
        console.log(`[${this.config.id}] Failed to create branch: ${branchName}`);
        return undefined;
      }

      // Commit each changed file
      for (const change of fileChanges) {
        const existing = await github.readFile(repoOwner, repoName, change.path, defaultBranch);
        await github.updateFile(
          repoOwner,
          repoName,
          change.path,
          change.content,
          instruction.slice(0, 50),
          branchName,
          existing?.sha,
        );
      }

      // Create PR
      const pr = await github.createPR(
        repoOwner,
        repoName,
        instruction.slice(0, 72),
        [
          "## Changes",
          "",
          `Generated by CodeSpar task agent (\`${this.config.id}\`).`,
          "",
          `**Instruction:** ${instruction}`,
          "",
          `**Files changed:** ${fileChanges.map((f) => f.path).join(", ")}`,
        ].join("\n"),
        branchName,
        defaultBranch,
      );

      if (pr) {
        console.log(`[${this.config.id}] PR #${pr.number} created: ${pr.url}`);
        return pr.url;
      }

      console.log(`[${this.config.id}] PR creation failed for branch ${branchName}`);
      return undefined;
    } catch (err) {
      console.log(`[${this.config.id}] PR creation error: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
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
      orgId: this.config.orgId,
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
