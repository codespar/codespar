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
} from "@codespar/core";

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

  constructor(config: AgentConfig) {
    this.config = {
      ...config,
      type: "project",
    };
  }

  get state(): AgentState {
    return this._state;
  }

  async initialize(): Promise<void> {
    this._state = "INITIALIZING";
    // Future: load codebase context, CI/CD config, channel links
    this.startedAt = new Date();
    this._state = "IDLE";
  }

  async handleMessage(
    message: NormalizedMessage,
    intent: ParsedIntent
  ): Promise<ChannelResponse> {
    this._state = "ACTIVE";
    this.tasksHandled++;

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
        response = {
          text: `[${this.config.id}] Recent activity:\n  ${this.tasksHandled} commands handled since ${this.startedAt.toISOString()}`,
        };
        break;

      case "instruct":
      case "fix":
        response = {
          text: `[${this.config.id}] Task queued: "${intent.params.instruction || intent.params.issue}"\n  (Task Agent execution coming in Phase 2)`,
        };
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
