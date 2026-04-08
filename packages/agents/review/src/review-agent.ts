/**
 * Review Agent — Ephemeral agent for PR code review.
 *
 * Responsibilities:
 * - Fetches real PR data and diff from GitHub API
 * - Analyzes code changes with Claude Sonnet for detailed review
 * - Classifies risk level based on diff size and file sensitivity
 * - Auto-approves low-risk PRs when autonomy level permits (L3+)
 * - Falls back to metadata-only review when GitHub is not configured
 * - Tracks review history for the session
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

import { GitHubClient, sanitizeForPrompt } from "@codespar/core";

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
        response = await this.reviewPR({
          prNumber,
          repoOwner: intent.params.repoOwner,
          repoName: intent.params.repoName,
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
   * Main review entry point. Attempts a full GitHub-backed review with
   * Claude Sonnet analysis. Falls back to metadata-only when GitHub
   * is not configured or repo info is missing.
   */
  async reviewPR(prData: {
    prNumber: number;
    repoOwner?: string;
    repoName?: string;
  }): Promise<ChannelResponse> {
    const github = new GitHubClient();

    if (github.isConfigured() && prData.repoOwner && prData.repoName) {
      return this.reviewWithGitHub(
        github,
        prData.repoOwner,
        prData.repoName,
        prData.prNumber,
      );
    }

    return this.reviewMetadataOnly(prData.prNumber);
  }

  /**
   * Full review: fetch PR from GitHub, analyze diff with Claude Sonnet,
   * return a detailed review with the PR link.
   */
  private async reviewWithGitHub(
    github: GitHubClient,
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<ChannelResponse> {
    // 1. Fetch PR details
    const pr = await github.getPR(owner, repo, prNumber);
    if (!pr) {
      return {
        text: `[${this.config.id}] Could not fetch PR #${prNumber} from ${owner}/${repo}. Check that the PR exists and GITHUB_TOKEN has access.`,
      };
    }

    // 2. Fetch PR files/diff
    const files = await github.getPRFiles(owner, repo, prNumber);

    // 3. Classify risk
    const hasSensitiveFiles = files.some((f) =>
      SENSITIVE_PATTERNS.some((p) => p.test(f.filename)),
    );
    const totalChanges = pr.additions + pr.deletions;
    const risk: "low" | "medium" | "high" = hasSensitiveFiles
      ? "high"
      : totalChanges > 200
        ? "high"
        : totalChanges > 50
          ? "medium"
          : "low";

    // 4. Analyze with Claude Sonnet
    let aiReview = "";
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey && files.length > 0) {
      aiReview = await this.analyzeWithClaude(apiKey, pr.title, files);
    }

    // 5. Auto-approve decision
    const autoApprove =
      this.config.autonomyLevel >= 3 && risk === "low";
    const decision = autoApprove
      ? `\u2713 Auto-approved (L${this.config.autonomyLevel} policy)`
      : "Awaiting manual review";

    // 6. Record in history
    const review: PRReview = {
      prNumber,
      title: pr.title,
      author: pr.author,
      branch: pr.branch,
      filesChanged: pr.changedFiles,
      additions: pr.additions,
      deletions: pr.deletions,
      riskLevel: risk,
      autoApproved: autoApprove,
      summary: aiReview || "No AI analysis available",
      suggestions: [],
      reviewedAt: new Date(),
    };
    this.reviewHistory.push(review);

    // 7. Audit log
    if (this.storage) {
      this.storage.appendAudit({
        actorType: "agent",
        actorId: this.config.id,
        action: "pr.reviewed",
        result: "success",
        metadata: {
          agentId: this.config.id,
          project: this.config.projectId || "unknown",
          risk,
          detail: `PR #${prNumber}. Risk: ${risk}. ${autoApprove ? "Auto-approved" : "Awaiting review"}`,
          prNumber,
          url: pr.url,
        },
      });
    }

    // 8. Format response
    const filesList = files
      .slice(0, 10)
      .map((f) => {
        const icon =
          f.status === "added" ? "+" : f.status === "removed" ? "-" : "~";
        return `    ${icon} ${f.filename}`;
      })
      .join("\n");

    const riskLabel =
      risk.charAt(0).toUpperCase() + risk.slice(1);
    const riskIcon =
      risk === "low" ? "\u2713" : risk === "high" ? "\u26a0" : "";

    const lines = [
      `[${this.config.id}] PR #${prNumber} Review`,
      ``,
      `  Title: ${pr.title}`,
      `  URL: ${pr.url}`,
      `  Author: ${pr.author} \u00b7 Branch: ${pr.branch} \u2192 ${pr.baseBranch}`,
      `  Changes: ${pr.changedFiles} file(s) \u00b7 +${pr.additions} -${pr.deletions} lines`,
      ``,
      `  Files:`,
      filesList,
    ];

    if (files.length > 10) {
      lines.push(`    ... and ${files.length - 10} more`);
    }

    lines.push(
      ``,
      `  Risk: ${riskLabel} ${riskIcon}`,
      `  Decision: ${decision}`,
    );

    if (aiReview) {
      lines.push(``, `  Review:`, `  ${aiReview}`);
    }

    lines.push(``, `  ${pr.url}`);

    return { text: lines.join("\n") };
  }

  /**
   * Call the Anthropic Messages API to analyze the PR diff.
   * Returns the review text, or empty string on failure.
   */
  private async analyzeWithClaude(
    apiKey: string,
    prTitle: string,
    files: Array<{
      filename: string;
      status: string;
      additions: number;
      deletions: number;
      patch: string;
    }>,
  ): Promise<string> {
    // Sanitize untrusted PR content before it enters the Claude prompt
    const safePrTitle = sanitizeForPrompt(prTitle, "pr_title").text;
    const diffContext = files
      .slice(0, 10)
      .map(
        (f) =>
          `### ${f.filename} (${f.status}, +${f.additions} -${f.deletions})\n\`\`\`diff\n${sanitizeForPrompt(f.patch.slice(0, 3000), "pr_diff").text}\n\`\`\``,
      )
      .join("\n\n");

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: process.env.REVIEW_MODEL || "claude-sonnet-4-20250514",
          max_tokens: 1000,
          system:
            "You are a senior code reviewer. Analyze the PR diff and provide a concise review. Focus on: bugs, security issues, code quality, and suggestions. Be direct. Use bullet points. Keep it under 200 words.",
          messages: [
            { role: "user", content: `PR: ${safePrTitle}\n\n${diffContext}` },
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

  /**
   * Fallback review when GitHub is not configured.
   * Produces a metadata-only review with a note about missing GitHub integration.
   */
  private reviewMetadataOnly(prNumber: number): ChannelResponse {
    const lines = [
      `[${this.config.id}] PR #${prNumber} Review`,
      ``,
      `  No diff data available (metadata-only review).`,
      `  To enable full reviews, configure GITHUB_TOKEN and link a repository.`,
      ``,
      `  Risk: Unknown`,
      `  Decision: Awaiting manual review`,
    ];

    // Record in history
    const review: PRReview = {
      prNumber,
      title: `PR #${prNumber}`,
      author: "unknown",
      branch: "unknown",
      filesChanged: 0,
      additions: 0,
      deletions: 0,
      riskLevel: "low",
      autoApproved: false,
      summary: "Metadata-only review (no GitHub access)",
      suggestions: [],
      reviewedAt: new Date(),
    };
    this.reviewHistory.push(review);

    if (this.storage) {
      this.storage.appendAudit({
        actorType: "agent",
        actorId: this.config.id,
        action: "pr.reviewed",
        result: "success",
        metadata: {
          agentId: this.config.id,
          project: this.config.projectId || "unknown",
          risk: "low",
          detail: `PR #${prNumber}. Metadata-only review (no GitHub access)`,
          prNumber,
        },
      });
    }

    return { text: lines.join("\n") };
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
