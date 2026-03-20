/**
 * Review Agent — Ephemeral agent for PR code review.
 *
 * Responsibilities:
 * - Analyzes PR metadata and produces a structured review
 * - Classifies risk level based on diff size and file sensitivity
 * - Auto-approves low-risk PRs when autonomy level permits (L3+)
 * - Tracks review history for the session
 *
 * MVP: Generates structured reviews from PR metadata.
 * Future: Claude Code bridge for actual code analysis.
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

export interface PRReview {
  prNumber: number;
  title: string;
  author: string;
  branch: string;
  filesChanged: number;
  additions: number;
  deletions: number;
  riskLevel: "low" | "medium" | "high";
  autoApproved: boolean;
  summary: string;
  suggestions: string[];
  reviewedAt: Date;
}

/** Files that indicate security-sensitive changes */
const SENSITIVE_PATTERNS = [
  /\.env/i,
  /auth/i,
  /middleware/i,
  /migration/i,
  /secret/i,
  /credential/i,
  /token/i,
  /password/i,
  /\.lock$/i,
];

export class ReviewAgent implements Agent {
  readonly config: AgentConfig;
  private _state: AgentState = "INITIALIZING";
  private startedAt: Date = new Date();
  private tasksHandled: number = 0;
  private reviewHistory: PRReview[] = [];
  private storage: StorageProvider | null;

  constructor(config: AgentConfig, storage?: StorageProvider) {
    this.config = {
      ...config,
      type: "review",
    };
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

  async handleMessage(
    message: NormalizedMessage,
    intent: ParsedIntent
  ): Promise<ChannelResponse> {
    this._state = "ACTIVE";
    this.tasksHandled++;

    let response: ChannelResponse;

    if (intent.type === "review") {
      const prNumber = intent.params.prNumber
        ? parseInt(intent.params.prNumber, 10)
        : undefined;

      if (!prNumber) {
        response = {
          text: `[${this.config.id}] Usage: review PR #<number>\n  Example: review PR #42`,
        };
      } else {
        // MVP: Generate a placeholder review from the PR number.
        // In production, this would fetch PR data from GitHub API.
        response = this.reviewPR({
          prNumber,
          title: `PR #${prNumber}`,
          author: message.channelUserId,
          branch: "unknown",
          filesChanged: 0,
          additions: 0,
          deletions: 0,
          changedFiles: [],
        });
      }
    } else {
      response = {
        text: `[${this.config.id}] Review Agent does not handle "${intent.type}" intents.`,
      };
    }

    this._state = "IDLE";
    return response;
  }

  /**
   * Main review logic. Analyzes PR data and returns a formatted review.
   */
  reviewPR(prData: {
    prNumber: number;
    title: string;
    author: string;
    branch: string;
    filesChanged: number;
    additions: number;
    deletions: number;
    changedFiles?: string[];
  }): ChannelResponse {
    const totalLines = prData.additions + prData.deletions;
    const touchesSensitive = this.hasSensitiveFiles(prData.changedFiles ?? []);
    const riskLevel = this.classifyRisk(totalLines, touchesSensitive);

    const autonomyLevel = this.config.autonomyLevel;
    const autoApproved = this.shouldAutoApprove(riskLevel, autonomyLevel);

    const summary = this.generateSummary(prData, riskLevel, touchesSensitive);
    const suggestions = this.generateSuggestions(
      prData,
      riskLevel,
      touchesSensitive
    );

    const review: PRReview = {
      prNumber: prData.prNumber,
      title: prData.title,
      author: prData.author,
      branch: prData.branch,
      filesChanged: prData.filesChanged,
      additions: prData.additions,
      deletions: prData.deletions,
      riskLevel,
      autoApproved,
      summary,
      suggestions,
      reviewedAt: new Date(),
    };

    this.reviewHistory.push(review);

    if (this.storage) {
      // Fire-and-forget; reviewPR is sync so we don't await
      this.storage.appendAudit({
        actorType: "agent",
        actorId: this.config.id,
        action: "pr.reviewed",
        result: "success",
        metadata: {
          agentId: this.config.id,
          project: this.config.projectId || "unknown",
          risk: riskLevel,
          detail: `PR #${prData.prNumber}. Risk: ${riskLevel}. ${autoApproved ? "Auto-approved" : "Awaiting review"}`,
          prNumber: prData.prNumber,
        },
      });
    }

    return { text: this.formatReview(review) };
  }

  /**
   * Classify risk based on diff size and file sensitivity.
   *
   * - Low: <50 lines changed, no sensitive files
   * - Medium: 50-200 lines, or touches test files
   * - High: >200 lines, touches sensitive files, or is a migration
   */
  private classifyRisk(
    totalLines: number,
    touchesSensitive: boolean
  ): "low" | "medium" | "high" {
    if (touchesSensitive || totalLines > 200) {
      return "high";
    }
    if (totalLines >= 50) {
      return "medium";
    }
    return "low";
  }

  /**
   * Determine whether to auto-approve based on risk and autonomy level.
   *
   * - L3+: auto-approve low-risk PRs
   * - L2: never auto-approve (suggest only)
   * - L0-L1: never auto-approve
   */
  private shouldAutoApprove(
    riskLevel: "low" | "medium" | "high",
    autonomyLevel: number
  ): boolean {
    if (riskLevel !== "low") return false;
    return autonomyLevel >= 3;
  }

  /**
   * Check if any changed files match security-sensitive patterns.
   */
  private hasSensitiveFiles(changedFiles: string[]): boolean {
    return changedFiles.some((file) =>
      SENSITIVE_PATTERNS.some((pattern) => pattern.test(file))
    );
  }

  /**
   * Generate a human-readable summary of the PR.
   */
  private generateSummary(
    prData: {
      prNumber: number;
      additions: number;
      deletions: number;
      filesChanged: number;
    },
    riskLevel: string,
    touchesSensitive: boolean
  ): string {
    const parts: string[] = [];
    const totalLines = prData.additions + prData.deletions;

    if (totalLines === 0) {
      parts.push("No diff data available (metadata-only review)");
    } else if (totalLines < 50) {
      parts.push(
        `Small change: ${prData.filesChanged} file(s), +${prData.additions} -${prData.deletions}`
      );
    } else if (totalLines <= 200) {
      parts.push(
        `Medium change: ${prData.filesChanged} file(s), +${prData.additions} -${prData.deletions}`
      );
    } else {
      parts.push(
        `Large change: ${prData.filesChanged} file(s), +${prData.additions} -${prData.deletions}`
      );
    }

    if (touchesSensitive) {
      parts.push("Security-sensitive files modified");
    } else {
      parts.push("No security-sensitive files modified");
    }

    return parts.join("\n  - ");
  }

  /**
   * Generate actionable suggestions based on PR characteristics.
   */
  private generateSuggestions(
    prData: { additions: number; deletions: number; filesChanged: number },
    riskLevel: string,
    touchesSensitive: boolean
  ): string[] {
    const suggestions: string[] = [];
    const totalLines = prData.additions + prData.deletions;

    if (totalLines > 400) {
      suggestions.push(
        "Consider splitting this PR into smaller, focused changes"
      );
    }

    if (touchesSensitive) {
      suggestions.push("Security-sensitive files changed — manual review required");
    }

    if (prData.additions > 0 && prData.deletions === 0 && totalLines > 100) {
      suggestions.push("Large addition with no deletions — check for dead code");
    }

    return suggestions;
  }

  /**
   * Format a PRReview into the agent output format.
   */
  private formatReview(review: PRReview): string {
    const riskIcon =
      review.riskLevel === "low"
        ? "\u2713"
        : review.riskLevel === "medium"
          ? "\u25cb"
          : "\u2717";

    const decision = review.autoApproved
      ? `\u2713 Auto-approved (L${this.config.autonomyLevel} policy)`
      : review.riskLevel === "low" && this.config.autonomyLevel >= 2
        ? `Suggest: approve (L${this.config.autonomyLevel} policy)`
        : `Awaiting manual review`;

    const suggestionsBlock =
      review.suggestions.length > 0
        ? review.suggestions.map((s) => `  - ${s}`).join("\n")
        : "  (none)";

    return [
      `[${this.config.id}] PR #${review.prNumber} Review`,
      ``,
      `  Title: ${review.title}`,
      `  Author: ${review.author} \u00b7 Branch: ${review.branch}`,
      `  Changes: ${review.filesChanged} file(s) \u00b7 +${review.additions} -${review.deletions} lines`,
      ``,
      `  Risk: ${review.riskLevel.charAt(0).toUpperCase() + review.riskLevel.slice(1)} ${riskIcon}`,
      `  Decision: ${decision}`,
      ``,
      `  Summary:`,
      `  - ${review.summary}`,
      ``,
      `  Suggestions:`,
      suggestionsBlock,
    ].join("\n");
  }

  /**
   * Return all reviews from this agent session.
   */
  getReviewHistory(): PRReview[] {
    return [...this.reviewHistory];
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
