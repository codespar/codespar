/**
 * Incident Agent — Ephemeral agent spawned on CI build failures.
 *
 * Responsibilities:
 * - Correlate failures with recent changes (commits, PRs)
 * - Propose a fix or investigation path
 * - Return a formatted investigation report
 *
 * MVP: Analyzes CIEvent metadata to produce an investigation summary.
 * Future: Uses Claude to analyze logs and correlate changes.
 */

import type {
  Agent,
  AgentConfig,
  AgentState,
  AgentStatus,
  NormalizedMessage,
  ChannelResponse,
  ParsedIntent,
  CIEvent,
  StorageProvider,
} from "@codespar/core";

export interface Investigation {
  error: string;
  recentChanges: string[];
  suspectedCause: string;
  suggestedFix: string;
  severity: "low" | "medium" | "high" | "critical";
}

export class IncidentAgent implements Agent {
  readonly config: AgentConfig;
  private _state: AgentState = "INITIALIZING";
  private startedAt: Date = new Date();
  private tasksHandled: number = 0;
  private storage: StorageProvider | null;

  constructor(config: AgentConfig, storage?: StorageProvider) {
    this.config = { ...config, type: "incident" };
    this.storage = storage ?? null;
  }

  get state(): AgentState {
    return this._state;
  }

  async initialize(): Promise<void> {
    this._state = "INITIALIZING";
    this.startedAt = new Date();
    this._state = "IDLE";
  }

  /**
   * Incident Agent does not handle direct user messages.
   * It is spawned programmatically by the Project Agent on CI failures.
   */
  async handleMessage(
    _message: NormalizedMessage,
    _intent: ParsedIntent
  ): Promise<ChannelResponse> {
    return {
      text: `[${this.config.id}] Incident Agent does not accept direct commands. It is spawned automatically on CI failures.`,
    };
  }

  /**
   * Investigate a CI failure event.
   *
   * Correlates the failure with recent audit entries (if storage is available)
   * and produces a structured investigation report.
   *
   * MVP: Analyzes event metadata for a basic investigation.
   * Future: Use Claude to analyze CI logs and correlate with code changes.
   */
  async investigate(event: CIEvent): Promise<Investigation> {
    this._state = "ACTIVE";
    this.tasksHandled++;

    const recentChanges: string[] = [];

    // Include commit SHA if available
    if (event.details.sha) {
      recentChanges.push(`Last commit: ${event.details.sha.slice(0, 8)}`);
    }

    // Include PR number if available
    if (event.details.prNumber) {
      recentChanges.push(`Related PR: #${event.details.prNumber}`);
    }

    // Pull recent audit entries for additional context
    if (this.storage) {
      const entries = await this.storage.queryAudit("", 5);
      for (const entry of entries) {
        const detail = entry.metadata?.detail;
        if (typeof detail === "string") {
          recentChanges.push(detail);
        }
      }
    }

    // If no changes found, note that
    if (recentChanges.length === 0) {
      recentChanges.push("No recent changes found in audit log");
    }

    // Determine severity based on event details
    const severity = this.assessSeverity(event);

    // Determine suspected cause from conclusion
    const suspectedCause = this.determineCause(event);

    // Suggest a fix based on the event type and conclusion
    const suggestedFix = this.suggestFix(event);

    const investigation: Investigation = {
      error: `Build failed on ${event.branch}`,
      recentChanges,
      suspectedCause,
      suggestedFix,
      severity,
    };

    this._state = "IDLE";
    return investigation;
  }

  /**
   * Format an investigation into a human-readable report string.
   */
  formatReport(investigation: Investigation): string {
    const changesBlock = investigation.recentChanges
      .map((c) => `  - ${c}`)
      .join("\n");

    return [
      `\u{1F50D} [${this.config.id}] Build Failure Investigation`,
      ``,
      `  Error: ${investigation.error}`,
      `  Severity: ${investigation.severity}`,
      ``,
      `  Recent changes:`,
      changesBlock,
      ``,
      `  Suspected cause: ${investigation.suspectedCause}`,
      `  Suggested fix: ${investigation.suggestedFix}`,
      ``,
      `  Next steps:`,
      `  - Use @codespar fix <description> to auto-fix`,
      `  - Use @codespar logs to see recent activity`,
    ].join("\n");
  }

  /**
   * Assess severity based on event characteristics.
   * - Main/master branch failures are high/critical
   * - Feature branch failures are medium
   * - Everything else is low
   */
  private assessSeverity(
    event: CIEvent
  ): "low" | "medium" | "high" | "critical" {
    const isMainBranch =
      event.branch === "main" || event.branch === "master";

    if (event.details.conclusion === "failure") {
      return isMainBranch ? "critical" : "high";
    }

    if (
      event.details.conclusion === "timed_out" ||
      event.details.conclusion === "cancelled"
    ) {
      return isMainBranch ? "high" : "medium";
    }

    return "medium";
  }

  /**
   * Determine the suspected cause from event metadata.
   */
  private determineCause(event: CIEvent): string {
    switch (event.details.conclusion) {
      case "failure":
        return "Test failure or compilation error";
      case "timed_out":
        return "Build exceeded time limit — possible infinite loop or resource exhaustion";
      case "cancelled":
        return "Build was cancelled — possibly superseded by a newer commit";
      case "action_required":
        return "Build requires manual action — check workflow permissions";
      default:
        return "Unknown failure — check CI logs for details";
    }
  }

  /**
   * Suggest a fix based on event type and conclusion.
   */
  private suggestFix(event: CIEvent): string {
    switch (event.details.conclusion) {
      case "failure":
        return "Investigate the failing step in CI logs";
      case "timed_out":
        return "Check for long-running tests or infinite loops; consider increasing timeout";
      case "cancelled":
        return "Verify the latest commit passes CI; re-run if cancelled in error";
      case "action_required":
        return "Review and approve the required workflow action";
      default:
        return "Review CI logs and recent changes for anomalies";
    }
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
  }
}
