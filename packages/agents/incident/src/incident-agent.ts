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

import { sanitizeForPrompt } from "@codespar/core";

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

    // Correlate with recent changes (commits, PRs, audit trail)
    const recentChanges = await this.correlateWithRecentChanges(event);

    // Determine severity based on error patterns
    const severity = this.classifySeverity(event);

    // Determine suspected cause from conclusion
    let suspectedCause = this.determineCause(event);

    // Suggest a fix based on the event type and conclusion
    let suggestedFix = this.suggestFix(event);

    // Attempt Claude analysis for richer investigation
    const aiAnalysis = await this.analyzeWithClaude(event, recentChanges);
    if (aiAnalysis) {
      suspectedCause = `${suspectedCause}\n\n  AI Analysis:\n  ${aiAnalysis}`;
    }

    const investigation: Investigation = {
      error: `Build failed on ${event.branch}`,
      recentChanges,
      suspectedCause,
      suggestedFix,
      severity,
    };

    if (this.storage) {
      await this.storage.appendAudit({
        actorType: "agent",
        actorId: this.config.id,
        action: "incident.investigated",
        result: "success",
        metadata: {
          agentId: this.config.id,
          project: this.config.projectId || "unknown",
          risk: severity,
          detail: `${investigation.error}. Severity: ${investigation.severity}`,
          branch: event.branch,
          repo: event.repo,
        },
      });
    }

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
   * Classify severity based on error patterns in the event.
   *
   * Pattern-based classification:
   * - deploy failure = critical (regardless of branch)
   * - build failure on main/master = critical
   * - build failure on feature branch = high
   * - test failure = medium
   * - timed_out / cancelled on main = high, on feature = medium
   * - everything else = low
   */
  classifySeverity(event: CIEvent): "low" | "medium" | "high" | "critical" {
    const isMainBranch =
      event.branch === "main" || event.branch === "master";

    const title = (event.details.title || "").toLowerCase();
    const conclusion = event.details.conclusion || "";

    // Deploy failures are always critical
    if (title.includes("deploy") && conclusion === "failure") {
      return "critical";
    }

    // Test failures are medium severity
    if (title.includes("test") && conclusion === "failure") {
      return "medium";
    }

    // Build failures: critical on main, high on feature
    if (conclusion === "failure") {
      return isMainBranch ? "critical" : "high";
    }

    if (conclusion === "timed_out" || conclusion === "cancelled") {
      return isMainBranch ? "high" : "medium";
    }

    return "low";
  }

  /**
   * Legacy method — delegates to classifySeverity for backward compatibility.
   */
  private assessSeverity(
    event: CIEvent
  ): "low" | "medium" | "high" | "critical" {
    return this.classifySeverity(event);
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

  /**
   * Extract commit/PR context from a CIEvent and recent audit entries.
   * Returns a list of human-readable change descriptions useful for
   * correlating a failure with what recently changed.
   */
  async correlateWithRecentChanges(event: CIEvent): Promise<string[]> {
    const changes: string[] = [];

    // Extract commit info from event metadata
    if (event.details.sha) {
      changes.push(`Commit: ${event.details.sha.slice(0, 8)}`);
    }

    if (event.details.prNumber) {
      changes.push(`PR: #${event.details.prNumber}`);
    }

    if (event.details.commitsCount) {
      changes.push(`Commits in push: ${event.details.commitsCount}`);
    }

    if (event.details.title) {
      changes.push(`Workflow: ${event.details.title}`);
    }

    // Pull recent audit entries for deploy/fix activity
    if (this.storage) {
      const { entries } = await this.storage.queryAudit("", 10);
      for (const entry of entries) {
        const action = entry.action;
        const detail = entry.metadata?.detail;

        // Only include deploy/fix/rollback actions — not noise
        if (
          typeof detail === "string" &&
          (action.startsWith("deploy.") ||
            action.startsWith("rollback.") ||
            action.startsWith("fix.") ||
            action.startsWith("pr."))
        ) {
          changes.push(`${action}: ${detail}`);
        }
      }
    }

    if (changes.length === 0) {
      changes.push("No recent changes found");
    }

    return changes;
  }

  /**
   * Call the Anthropic Messages API to analyze build logs and produce
   * an AI-powered investigation summary. Returns empty string on failure
   * (graceful degradation — investigation proceeds without AI).
   */
  async analyzeWithClaude(event: CIEvent, recentChanges: string[]): Promise<string> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return "";
    }

    const changesContext = recentChanges.map((c) => `- ${c}`).join("\n");
    const eventSummary = sanitizeForPrompt(
      [
        `Repo: ${event.repo}`,
        `Branch: ${event.branch}`,
        `Status: ${event.status}`,
        `Conclusion: ${event.details.conclusion || "unknown"}`,
        `Workflow: ${event.details.title || "unknown"}`,
        event.details.url ? `URL: ${event.details.url}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
      "ci_error"
    ).text;

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: process.env.INCIDENT_MODEL || "claude-sonnet-4-20250514",
          max_tokens: 800,
          system:
            "You are a senior SRE investigating a CI/CD failure. Analyze the build failure context and recent changes. Provide: 1) Most likely root cause, 2) Recommended immediate action, 3) Whether this is likely a flaky test or a real regression. Be concise and direct. Use bullet points. Keep it under 150 words.",
          messages: [
            {
              role: "user",
              content: `Build failure:\n${eventSummary}\n\nRecent changes:\n${changesContext}`,
            },
          ],
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (res.ok) {
        const data = (await res.json()) as {
          content?: Array<{ text?: string }>;
        };
        return data.content?.[0]?.text || "";
      }

      return "";
    } catch {
      // Timeout or network error — degrade gracefully
      return "";
    }
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
  }
}
