/**
 * Coordinator Agent — Persistent, per-org agent for cross-project orchestration.
 *
 * Responsibilities:
 * - Maintains a registry of project agents it coordinates
 * - Routes commands to specific project agents when project alias is specified
 * - Handles cross-project commands ("all status", "deploy gw then front")
 * - Aggregates status across all registered projects
 * - Tracks cascading deploy sequences (state machine, not actual execution yet)
 *
 * MVP: Registered in supervisor, delegates multi-project commands.
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

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

export interface ProjectRegistry {
  /** Short alias used in commands (e.g. "gw", "front", "mob") */
  alias: string;
  /** Full project identifier (e.g. "api-gateway") */
  projectId: string;
  /** ID of the project agent (e.g. "agent-gw") */
  agentId: string;
}

export type CascadeStepStatus =
  | "pending"
  | "deploying"
  | "deployed"
  | "failed";

export interface CascadeStep {
  projectAlias: string;
  status: CascadeStepStatus;
  startedAt?: Date;
  completedAt?: Date;
}

export interface CascadeDeploy {
  id: string;
  steps: CascadeStep[];
  requestedBy: string;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Status display symbols
// ---------------------------------------------------------------------------

const STATE_SYMBOLS: Record<AgentState, string> = {
  INITIALIZING: "○",
  IDLE: "○",
  ACTIVE: "✓",
  WAITING_APPROVAL: "◑",
  SUSPENDED: "◑",
  ERROR: "✗",
  TERMINATED: "✗",
};

const STEP_SYMBOLS: Record<CascadeStepStatus, string> = {
  pending: "○",
  deploying: "◑",
  deployed: "✓",
  failed: "✗",
};

// ---------------------------------------------------------------------------
// CoordinatorAgent
// ---------------------------------------------------------------------------

export class CoordinatorAgent implements Agent {
  readonly config: AgentConfig;
  private _state: AgentState = "INITIALIZING";
  private startedAt: Date = new Date();
  private tasksHandled: number = 0;

  /** alias → ProjectRegistry */
  private projects: Map<string, ProjectRegistry> = new Map();

  /** Resolved project agents (populated via setProjectAgent) */
  private projectAgents: Map<string, Agent> = new Map();

  /** Active cascading deploys */
  private cascadeDeploys: Map<string, CascadeDeploy> = new Map();
  private cascadeCounter: number = 0;

  constructor(config: AgentConfig) {
    this.config = {
      ...config,
      type: "coordinator",
    };
  }

  get state(): AgentState {
    return this._state;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async initialize(): Promise<void> {
    this._state = "INITIALIZING";
    this.startedAt = new Date();
    this._state = "IDLE";
  }

  async shutdown(): Promise<void> {
    this._state = "TERMINATED";
  }

  // -----------------------------------------------------------------------
  // Project registration
  // -----------------------------------------------------------------------

  /**
   * Register a project the coordinator should manage.
   * Call this after the project agent has been spawned in the supervisor.
   */
  registerProject(alias: string, projectId: string, agentId: string): void {
    this.projects.set(alias, { alias, projectId, agentId });
  }

  /**
   * Provide a live reference to a project agent so the coordinator
   * can forward commands and query status directly.
   */
  setProjectAgent(alias: string, agent: Agent): void {
    this.projectAgents.set(alias, agent);
  }

  /** Remove a project from the registry. */
  unregisterProject(alias: string): void {
    this.projects.delete(alias);
    this.projectAgents.delete(alias);
  }

  /** Get all registered project entries. */
  getRegisteredProjects(): ProjectRegistry[] {
    return Array.from(this.projects.values());
  }

  // -----------------------------------------------------------------------
  // Message handling
  // -----------------------------------------------------------------------

  async handleMessage(
    message: NormalizedMessage,
    intent: ParsedIntent
  ): Promise<ChannelResponse> {
    this._state = "ACTIVE";
    this.tasksHandled++;

    const text = intent.rawText.trim().toLowerCase();

    let response: ChannelResponse;

    // "all status" — aggregate status across every project
    if (/^all\s+status$/i.test(text)) {
      response = await this.handleAllStatus();
    }
    // "deploy <alias> then <alias> [then <alias>...]" — cascading deploy
    else if (/^deploy\s+\S+\s+then\s+/i.test(text)) {
      response = this.handleCascadeDeploy(text, message.channelUserId);
    }
    // "<alias> <command>" — route to a specific project agent
    else {
      const aliasMatch = text.match(/^(\S+)\s+(.+)$/);
      if (aliasMatch && this.projects.has(aliasMatch[1])) {
        response = await this.routeToProject(
          aliasMatch[1],
          aliasMatch[2],
          message,
          intent
        );
      }
      // Bare "status" in a multi-project context — ask for clarification
      else if (intent.type === "status" && this.projects.size > 1) {
        const aliases = Array.from(this.projects.keys()).join(" | ");
        response = {
          text: `[coordinator] Which project? ${aliases}`,
        };
      }
      // Fallback
      else {
        response = {
          text: `[coordinator] Unknown coordinator command: "${intent.rawText}"\n  Available:\n    all status            — status of every project\n    <alias> <command>     — route to a project agent\n    deploy <a> then <b>   — cascading deploy`,
        };
      }
    }

    this._state = "IDLE";
    return response;
  }

  // -----------------------------------------------------------------------
  // All-status aggregation
  // -----------------------------------------------------------------------

  private async handleAllStatus(): Promise<ChannelResponse> {
    if (this.projects.size === 0) {
      return {
        text: "[coordinator] No projects registered.",
      };
    }

    const lines: string[] = [];

    // Query each project agent in parallel
    const entries = Array.from(this.projects.values());
    const statuses = await Promise.all(
      entries.map(async (entry) => {
        const agent = this.projectAgents.get(entry.alias);
        if (agent) {
          return { entry, status: agent.getStatus() };
        }
        return { entry, status: null };
      })
    );

    for (const { entry, status } of statuses) {
      if (status) {
        const sym = STATE_SYMBOLS[status.state] ?? "?";
        const tasks = String(status.tasksHandled).padStart(3, " ");
        lines.push(
          `  ${sym} ${status.id.padEnd(14)} ${entry.projectId.padEnd(16)} ${status.state.padEnd(9)} L${status.autonomyLevel}  ${tasks} tasks`
        );
      } else {
        lines.push(
          `  ? ${entry.agentId.padEnd(14)} ${entry.projectId.padEnd(16)} UNKNOWN   --    -- tasks`
        );
      }
    }

    return {
      text: `[coordinator] All projects status:\n${lines.join("\n")}`,
    };
  }

  // -----------------------------------------------------------------------
  // Route to specific project agent
  // -----------------------------------------------------------------------

  private async routeToProject(
    alias: string,
    commandText: string,
    message: NormalizedMessage,
    _originalIntent: ParsedIntent
  ): Promise<ChannelResponse> {
    const agent = this.projectAgents.get(alias);
    if (!agent) {
      const entry = this.projects.get(alias);
      return {
        text: `[coordinator] Project "${alias}" is registered (${entry?.projectId}) but its agent is not connected.`,
      };
    }

    // Re-parse the command portion (without the alias prefix) into a new intent
    const { parseIntent } = await import("@codespar/core");
    const routedIntent = await parseIntent(commandText);

    return agent.handleMessage(message, routedIntent);
  }

  // -----------------------------------------------------------------------
  // Cascading deploy
  // -----------------------------------------------------------------------

  /**
   * Parse "deploy gw then front [then mob]" and create a CascadeDeploy.
   * MVP: tracks state only — does not execute actual deploys.
   */
  private handleCascadeDeploy(
    text: string,
    requestedBy: string
  ): ChannelResponse {
    // Extract aliases: "deploy gw then front then mob"
    const withoutPrefix = text.replace(/^deploy\s+/i, "");
    const aliases = withoutPrefix
      .split(/\s+then\s+/i)
      .map((s) => s.trim())
      .filter(Boolean);

    // Validate all aliases exist
    const unknownAliases = aliases.filter((a) => !this.projects.has(a));
    if (unknownAliases.length > 0) {
      return {
        text: `[coordinator] Unknown project alias(es): ${unknownAliases.join(", ")}\n  Registered: ${Array.from(this.projects.keys()).join(", ")}`,
      };
    }

    // Create the cascade deploy
    this.cascadeCounter++;
    const deployId = `cascade-${this.cascadeCounter}`;
    const cascade: CascadeDeploy = {
      id: deployId,
      steps: aliases.map((alias) => ({
        projectAlias: alias,
        status: "pending" as CascadeStepStatus,
      })),
      requestedBy,
      createdAt: new Date(),
    };

    this.cascadeDeploys.set(deployId, cascade);

    // Simulate starting the first step
    cascade.steps[0].status = "deploying";
    cascade.steps[0].startedAt = new Date();

    const projectNames = aliases.map(
      (a) => this.projects.get(a)!.projectId
    );
    const arrow = projectNames.join(" → ");

    const stepLines = cascade.steps.map((step, i) => {
      const entry = this.projects.get(step.projectAlias)!;
      const sym = STEP_SYMBOLS[step.status];
      const statusLabel =
        step.status === "deploying"
          ? `Deploying ${entry.projectId}...`
          : step.status === "pending"
            ? `Pending`
            : step.status === "deployed"
              ? `${entry.projectId} healthy`
              : `${entry.projectId} failed`;
      return `  Step ${i + 1}: ${sym} ${statusLabel}`;
    });

    return {
      text: `[coordinator] Deploy sequence: ${arrow}\n${stepLines.join("\n")}\n  ID: ${deployId} | Requested by: ${requestedBy}`,
    };
  }

  /**
   * Advance a cascade deploy step. Called when a deploy completes.
   * Returns a status message, or null if the cascade is not found.
   */
  advanceCascade(
    deployId: string,
    success: boolean
  ): ChannelResponse | null {
    const cascade = this.cascadeDeploys.get(deployId);
    if (!cascade) return null;

    // Find the currently deploying step
    const currentIdx = cascade.steps.findIndex(
      (s) => s.status === "deploying"
    );
    if (currentIdx === -1) return null;

    const current = cascade.steps[currentIdx];
    current.completedAt = new Date();

    if (!success) {
      current.status = "failed";
      const entry = this.projects.get(current.projectAlias)!;
      return {
        text: `[coordinator] Deploy sequence ${deployId} FAILED at step ${currentIdx + 1}: ${entry.projectId}\n  Remaining steps cancelled.`,
      };
    }

    current.status = "deployed";

    // Check if there are more steps
    const nextIdx = currentIdx + 1;
    if (nextIdx < cascade.steps.length) {
      const next = cascade.steps[nextIdx];
      next.status = "deploying";
      next.startedAt = new Date();
      const nextEntry = this.projects.get(next.projectAlias)!;
      const currentEntry = this.projects.get(current.projectAlias)!;
      return {
        text: `[coordinator] Deploy sequence ${deployId}:\n  Step ${currentIdx + 1}: ✓ ${currentEntry.projectId} healthy\n  Step ${nextIdx + 1}: Deploying ${nextEntry.projectId}...`,
      };
    }

    // All steps complete
    const lines = cascade.steps.map((step, i) => {
      const entry = this.projects.get(step.projectAlias)!;
      return `  Step ${i + 1}: ✓ ${entry.projectId} healthy`;
    });

    return {
      text: `[coordinator] Deploy sequence ${deployId}:\n${lines.join("\n")}\n  All services deployed successfully.`,
    };
  }

  /** Get a cascade deploy by ID. */
  getCascadeDeploy(deployId: string): CascadeDeploy | undefined {
    return this.cascadeDeploys.get(deployId);
  }

  // -----------------------------------------------------------------------
  // Status
  // -----------------------------------------------------------------------

  getStatus(): AgentStatus {
    return {
      id: this.config.id,
      type: this.config.type,
      state: this._state,
      autonomyLevel: this.config.autonomyLevel,
      projectId: undefined,
      lastActiveAt: new Date(),
      uptimeMs: Date.now() - this.startedAt.getTime(),
      tasksHandled: this.tasksHandled,
    };
  }
}
