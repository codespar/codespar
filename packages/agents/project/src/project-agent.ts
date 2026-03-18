/**
 * Project Agent — Persistent, always-on agent per project.
 *
 * Responsibilities:
 * - Handles all @mention commands for its project
 * - Monitors repo, CI/CD, and channels
 * - Maintains codebase context
 * - Spawns ephemeral agents (Task, Review, Deploy, Incident)
 *
 * MVP: L1 Notify — responds to commands, never auto-executes.
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
  CIEvent,
} from "@codespar/core";

import { TaskAgent } from "@codespar/agent-task";

const COMMANDS_HELP = `Available commands:
  status [build|agent|all]  — Query current status
  help                      — Show this help
  logs [n]                  — Show recent activity

Coming soon:
  instruct [task]           — Instruct agent to execute
  fix [issue]               — Investigate and propose fix
  deploy [env]              — Trigger deployment
  rollback [env]            — Rollback last deploy
  approve [token]           — Approve pending action
  autonomy [L0-L5]          — Set autonomy level`;

export class ProjectAgent implements Agent {
  readonly config: AgentConfig;
  private _state: AgentState = "INITIALIZING";
  private startedAt: Date = new Date();
  private tasksHandled: number = 0;
  private taskAgentCounter: number = 0;
  private storage: StorageProvider | null;

  constructor(config: AgentConfig, storage?: StorageProvider) {
    this.config = {
      ...config,
      type: "project",
    };
    this.storage = storage ?? null;
  }

  get state(): AgentState {
    return this._state;
  }

  async initialize(): Promise<void> {
    this._state = "INITIALIZING";

    // Restore persisted task count from storage
    if (this.storage) {
      const savedCount = await this.storage.getMemory(
        this.config.id,
        "tasksHandled"
      );
      if (typeof savedCount === "number") {
        this.tasksHandled = savedCount;
      }
    }

    this.startedAt = new Date();
    this._state = "IDLE";
  }

  async handleMessage(
    message: NormalizedMessage,
    intent: ParsedIntent
  ): Promise<ChannelResponse> {
    this._state = "ACTIVE";
    this.tasksHandled++;

    // Persist task count and audit entry
    if (this.storage) {
      await this.storage.setMemory(
        this.config.id,
        "tasksHandled",
        this.tasksHandled
      );
      await this.storage.appendAudit({
        actorType: "user",
        actorId: message.channelUserId,
        action: intent.type,
        result: "success",
        metadata: {
          agentId: this.config.id,
          rawText: intent.rawText,
          channel: message.channelType,
        },
      });
    }

    let response: ChannelResponse;

    switch (intent.type) {
      case "status":
        response = this.handleStatus(intent);
        break;

      case "help":
        response = {
          text: `[${this.config.id}] ${COMMANDS_HELP}`,
        };
        break;

      case "logs":
        response = await this.handleLogs(intent);
        break;

      case "instruct":
      case "fix":
        response = await this.delegateToTaskAgent(message, intent);
        break;

      case "deploy":
        response = {
          text: `[${this.config.id}] Deploy to ${intent.params.environment} requires approval.\n  (Deploy Agent coming in Phase 3)`,
        };
        break;

      case "rollback":
        response = {
          text: `[${this.config.id}] Rollback ${intent.params.environment} requires quorum (2 approvals).\n  (Rollback flow coming in Phase 3)`,
        };
        break;

      case "autonomy":
        response = {
          text: `[${this.config.id}] Autonomy level change to L${intent.params.level} requires operator+ role.\n  (RBAC coming in Phase 3)`,
        };
        break;

      case "kill":
        response = {
          text: `[${this.config.id}] Kill switch requires emergency_admin role.\n  (Kill switch coming in Phase 3)`,
        };
        break;

      case "unknown":
      default:
        response = {
          text: `[${this.config.id}] Unknown command: "${intent.rawText}"\n  Type "help" for available commands.`,
        };
        break;
    }

    this._state = "IDLE";
    return response;
  }

  /**
   * Spawns an ephemeral Task Agent to handle instruct/fix commands.
   * The Task Agent runs the task and is discarded after completion.
   */
  private async delegateToTaskAgent(
    message: NormalizedMessage,
    intent: ParsedIntent
  ): Promise<ChannelResponse> {
    this.taskAgentCounter++;
    const taskAgentId = `${this.config.id}-task-${this.taskAgentCounter}`;

    const taskAgent = new TaskAgent({
      id: taskAgentId,
      type: "task",
      projectId: this.config.projectId,
      autonomyLevel: this.config.autonomyLevel,
    });

    await taskAgent.initialize();
    const result = await taskAgent.handleMessage(message, intent);
    await taskAgent.shutdown();

    return result;
  }

  private async handleLogs(intent: ParsedIntent): Promise<ChannelResponse> {
    if (!this.storage) {
      return {
        text: `[${this.config.id}] Recent activity:\n  ${this.tasksHandled} commands handled since ${this.startedAt.toISOString()}\n  (No storage configured — audit log unavailable)`,
      };
    }

    const limit = intent.params.count ? parseInt(intent.params.count, 10) : 10;
    const entries = await this.storage.queryAudit(
      // Query by user actor IDs — show all activity for this agent
      // queryAudit filters by actorId, so we query broadly using a known user
      "local-user",
      limit
    );

    if (entries.length === 0) {
      return {
        text: `[${this.config.id}] No audit entries found.`,
      };
    }

    const lines = entries.map((e) => {
      const ts = e.timestamp.toISOString().replace("T", " ").slice(0, 19);
      const meta = e.metadata?.rawText ? ` "${e.metadata.rawText}"` : "";
      return `  [${ts}] ${e.action} (${e.result})${meta}`;
    });

    return {
      text: `[${this.config.id}] Recent activity (${entries.length} entries):\n${lines.join("\n")}`,
    };
  }

  private handleStatus(intent: ParsedIntent): ChannelResponse {
    const target = intent.params.target || "all";
    const uptimeMs = Date.now() - this.startedAt.getTime();
    const uptimeMin = Math.floor(uptimeMs / 60000);

    const agentInfo = [
      `Agent: ${this.config.id}`,
      `State: ${this._state}`,
      `Autonomy: L${this.config.autonomyLevel} (${this.autonomyLabel()})`,
      `Uptime: ${uptimeMin}m`,
      `Tasks handled: ${this.tasksHandled}`,
    ].join("\n  ");

    if (target === "agent" || target === "all") {
      return {
        text: `\u2713 [${this.config.id}] Status:\n  ${agentInfo}`,
      };
    }

    // Build status (placeholder for CI/CD integration)
    return {
      text: `\u2713 [${this.config.id}] Build status:\n  (CI/CD integration coming in Phase 2)`,
    };
  }

  private autonomyLabel(): string {
    const labels: Record<number, string> = {
      0: "Passive",
      1: "Notify",
      2: "Suggest",
      3: "Auto-Low",
      4: "Auto-Med",
      5: "Full Auto",
    };
    return labels[this.config.autonomyLevel] || "Unknown";
  }

  /**
   * Handle a CI event from a GitHub webhook.
   * Formats the event into a human-readable agent message.
   */
  async handleCIEvent(event: CIEvent): Promise<ChannelResponse> {
    this._state = "ACTIVE";
    this.tasksHandled++;

    let text: string;

    switch (event.type) {
      case "workflow_run": {
        const runId = event.details.runId ?? "?";
        const title = event.details.title ? ` "${event.details.title}"` : "";
        const duration = event.details.duration
          ? ` (${event.details.duration}s)`
          : "";

        if (event.status === "success") {
          text = `\u2713 [${this.config.id}] Build #${runId}${title} \u2014 ${event.repo} (${event.branch}) | ${event.details.conclusion ?? "success"}${duration}`;
        } else if (event.status === "failure") {
          text = `\u2717 [${this.config.id}] Build #${runId}${title} failed \u2014 ${event.repo} (${event.branch}) | ${event.details.conclusion ?? "failure"}${duration}`;
        } else {
          text = `\u25cb [${this.config.id}] Build #${runId}${title} ${event.status} \u2014 ${event.repo} (${event.branch})`;
        }
        break;
      }

      case "check_run": {
        const checkName = event.details.title ?? "check";
        if (event.status === "success") {
          text = `\u2713 [${this.config.id}] Check "${checkName}" passed \u2014 ${event.repo} (${event.branch})`;
        } else {
          text = `\u2717 [${this.config.id}] Check "${checkName}" failed \u2014 ${event.repo} (${event.branch}) | ${event.details.conclusion ?? "failure"}`;
        }
        break;
      }

      case "pull_request": {
        const prNum = event.details.prNumber ?? "?";
        const prTitle = event.details.title ?? "untitled";
        const conclusion = event.details.conclusion;

        if (conclusion === "merged") {
          text = `\u2713 [${this.config.id}] PR #${prNum} merged: ${prTitle} \u2014 ${event.repo}`;
        } else if (event.status === "in_progress") {
          text = `[${this.config.id}] PR #${prNum} opened: ${prTitle} \u2014 ${event.repo} (${event.branch})`;
        } else {
          text = `[${this.config.id}] PR #${prNum} ${conclusion ?? "closed"}: ${prTitle} \u2014 ${event.repo}`;
        }
        break;
      }

      case "push": {
        const count = event.details.commitsCount ?? 0;
        const commitWord = count === 1 ? "commit" : "commits";
        text = `[${this.config.id}] Push: ${count} ${commitWord} to ${event.repo} (${event.branch})`;
        break;
      }

      default:
        text = `[${this.config.id}] CI event: ${event.type} on ${event.repo} (${event.branch})`;
    }

    if (event.details.url) {
      text += `\n  ${event.details.url}`;
    }

    this._state = "IDLE";
    return { text };
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
    // Future: persist state, save context snapshot
  }
}
