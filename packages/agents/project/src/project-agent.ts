/**
 * Project Agent — Persistent, always-on agent per project.
 *
 * Responsibilities:
 * - Handles all @mention commands for its project
 * - Monitors repo, CI/CD, and channels
 * - Maintains codebase context
 * - Spawns ephemeral agents (Task, Review, Deploy, Incident)
 *
 * Autonomy levels L0-L5 control auto-execution of actions by risk level.
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
  ProjectConfig,
  CIEvent,
} from "@codespar/core";

import { ApprovalManager, VectorStore, IdentityStore, GitHubClient, generateSmartResponse } from "@codespar/core";
import type { AgentContext } from "@codespar/core";
import { TaskAgent } from "@codespar/agent-task";
import { DeployAgent } from "@codespar/agent-deploy";
import { ReviewAgent } from "@codespar/agent-review";
import { IncidentAgent } from "@codespar/agent-incident";

const COMMANDS_HELP = `Available commands:
  status [build|agent|all]  — Query current status
  help                      — Show this help
  logs [n]                  — Show recent activity
  link <repo-url>           — Link a GitHub repo
  unlink                    — Remove current project link
  instruct [task]           — Execute a coding task
  fix [issue]               — Investigate and propose fix
  review PR #<number>       — Review a pull request
  deploy [env]              — Trigger deployment
  rollback [env]            — Rollback last deploy
  approve [token]           — Approve pending action
  autonomy [L0-L5]          — Set autonomy level
  prs [open|closed|all]     — List pull requests
  memory                    — Show agent memory stats
  whoami                    — Show your identity and linked channels
  register <name>           — Register your display name`;

export class ProjectAgent implements Agent {
  readonly config: AgentConfig;
  private _state: AgentState = "INITIALIZING";
  private startedAt: Date = new Date();
  private tasksHandled: number = 0;
  private taskAgentCounter: number = 0;
  private reviewAgentCounter: number = 0;
  private incidentAgentCounter: number = 0;
  private storage: StorageProvider | null;
  private vectorStore: VectorStore | null;
  private identityStore: IdentityStore | null = null;
  private approvalManager: ApprovalManager;
  private deployAgent: DeployAgent;

  constructor(
    config: AgentConfig,
    storage?: StorageProvider,
    approvalManager?: ApprovalManager,
    vectorStore?: VectorStore,
  ) {
    this.config = {
      ...config,
      type: "project",
    };
    this.storage = storage ?? null;
    this.vectorStore = vectorStore ?? null;
    this.approvalManager = approvalManager ?? new ApprovalManager();
    this.deployAgent = new DeployAgent(
      {
        id: `${config.id}-deploy`,
        type: "deploy",
        projectId: config.projectId,
        autonomyLevel: config.autonomyLevel,
      },
      this.approvalManager,
      this.storage ?? undefined
    );
  }

  /** Attach a persistent identity store for cross-channel user resolution. */
  setIdentityStore(store: IdentityStore): void {
    this.identityStore = store;
  }

  get state(): AgentState {
    return this._state;
  }

  async initialize(): Promise<void> {
    this._state = "INITIALIZING";

    // Restore persisted state from storage
    if (this.storage) {
      const savedCount = await this.storage.getMemory(
        this.config.id,
        "tasksHandled"
      );
      if (typeof savedCount === "number") {
        this.tasksHandled = savedCount;
      }

      // Restore persisted autonomy level
      const savedLevel = await this.storage.getMemory(
        this.config.id,
        "autonomyLevel"
      );
      if (typeof savedLevel === "number" && savedLevel >= 0 && savedLevel <= 5) {
        (this.config as { autonomyLevel: number }).autonomyLevel = savedLevel;
      }
    }

    // Initialize the Deploy Agent
    await this.deployAgent.initialize();

    this.startedAt = new Date();
    this._state = "IDLE";
  }

  async handleMessage(
    message: NormalizedMessage,
    intent: ParsedIntent
  ): Promise<ChannelResponse> {
    this._state = "ACTIVE";
    this.tasksHandled++;

    // Detect open-ended questions: long text with "?" classified by NLU (not regex)
    // These should go to the smart responder regardless of classified intent
    const isOpenQuestion = intent.rawText.includes("?")
      && intent.rawText.length > 25
      && intent.confidence < 1.0;

    // Extract image URLs from message attachments for visual context
    const imageUrls = message.attachments
      ?.filter((a) => a.type === "image" && a.url)
      .map((a) => ({ url: a.url, mimeType: a.mimeType }));

    if (isOpenQuestion) {
      const ctx = await this.buildAgentContext();
      const smartResponse = await generateSmartResponse(intent.rawText, ctx, imageUrls);
      if (smartResponse) {
        // Still persist audit
        if (this.storage) {
          await this.storage.setMemory(this.config.id, "tasksHandled", this.tasksHandled);
          await this.storage.appendAudit({
            actorType: "user",
            actorId: message.channelUserId,
            action: "query.asked",
            result: "success",
            metadata: {
              agentId: this.config.id,
              project: this.config.projectId || "unknown",
              risk: intent.risk || "low",
              detail: intent.rawText,
              channel: message.channelType,
              classifiedBy: "sonnet",
              confidence: 1.0,
            },
          });
        }
        if (this.vectorStore) {
          await this.vectorStore.add({
            agentId: this.config.id,
            content: `Q: ${intent.rawText}\nA: ${smartResponse.slice(0, 200)}`,
            category: "conversation",
            metadata: { type: "smart_response" },
          });
        }
        this._state = "IDLE";
        return { text: `[${this.config.id}] ${smartResponse}` };
      }
    }

    // Persist task count
    if (this.storage) {
      await this.storage.setMemory(
        this.config.id,
        "tasksHandled",
        this.tasksHandled
      );
    }

    let response: ChannelResponse;

    switch (intent.type) {
      case "status":
        response = await this.handleStatus(intent);
        if (this.storage) {
          await this.storage.appendAudit({
            actorType: "user",
            actorId: message.channelUserId,
            action: "status.queried",
            result: "success",
            metadata: {
              agentId: this.config.id,
              project: this.config.projectId || "unknown",
              risk: intent.risk,
              detail: `Queried ${intent.params.target || "all"} status`,
              channel: message.channelType,
            },
          });
        }
        break;

      case "help":
        response = {
          text: `[${this.config.id}] ${COMMANDS_HELP}`,
        };
        if (this.storage) {
          await this.storage.appendAudit({
            actorType: "user",
            actorId: message.channelUserId,
            action: "help.requested",
            result: "success",
            metadata: {
              agentId: this.config.id,
              project: this.config.projectId || "unknown",
              risk: intent.risk,
              detail: "Help menu displayed",
              channel: message.channelType,
            },
          });
        }
        break;

      case "logs": {
        const limit = intent.params.count ? parseInt(intent.params.count, 10) : 10;
        response = await this.handleLogs(intent);
        if (this.storage) {
          await this.storage.appendAudit({
            actorType: "user",
            actorId: message.channelUserId,
            action: "logs.viewed",
            result: "success",
            metadata: {
              agentId: this.config.id,
              project: this.config.projectId || "unknown",
              risk: intent.risk,
              detail: `Viewed ${limit} recent entries`,
              channel: message.channelType,
            },
          });
        }
        break;
      }

      case "review": {
        response = await this.delegateToReviewAgent(message, intent);
        const prNumber = intent.params.prNumber
          ? parseInt(intent.params.prNumber, 10)
          : 0;
        if (this.storage) {
          await this.storage.appendAudit({
            actorType: "agent",
            actorId: this.config.id,
            action: "pr.reviewed",
            result: "success",
            metadata: {
              agentId: this.config.id,
              project: this.config.projectId || "unknown",
              risk: intent.risk,
              detail: `PR #${prNumber} reviewed`,
              channel: message.channelType,
            },
          });
        }
        break;
      }

      case "prs": {
        response = await this.handleListPRs(intent, message);
        break;
      }

      case "context": {
        // If the original question is complex (long text, classified by NLU),
        // try a smart response instead of just showing memory stats.
        if (intent.rawText.length > 30 && intent.confidence < 1.0) {
          const ctx = await this.buildAgentContext();
          const smartResponse = await generateSmartResponse(intent.rawText, ctx, imageUrls);
          if (smartResponse) {
            response = {
              text: `[${this.config.id}] ${smartResponse}`,
            };
            // Store smart conversation in vector memory
            if (this.vectorStore) {
              await this.vectorStore.add({
                agentId: this.config.id,
                content: `Q: ${intent.rawText}\nA: ${smartResponse.slice(0, 200)}`,
                category: "conversation",
                metadata: { type: "smart_response" },
              });
            }
            break;
          }
        }
        response = this.handleMemoryStats();
        break;
      }

      case "instruct":
      case "fix": {
        // Search vector memory for similar past tasks
        let similarContext = "";
        if (this.vectorStore) {
          const similar = await this.vectorStore.search(
            intent.rawText,
            3,
            "conversation",
          );
          // Only show results that look like task instructions (not status queries or help)
          const taskSimilar = similar.filter((s) => {
            if (s.score <= 0.4) return false;
            const lower = s.entry.content.toLowerCase();
            return lower.includes("instruct") || lower.includes("fix");
          });
          if (taskSimilar.length > 0) {
            const lines = taskSimilar.map(
              (s) =>
                `  - (${(s.score * 100).toFixed(0)}%) ${s.entry.content.split("\n")[0]}`,
            );
            similarContext = `\n\nSimilar past tasks found:\n${lines.join("\n")}`;
          }
        }

        const instruction = intent.params.instruction || intent.params.issue || intent.rawText;

        if (this.shouldAutoExecute(intent)) {
          // L4+: auto-execute without confirmation, notify after
          const result = await this.delegateToTaskAgent(message, intent);
          response = {
            text: `[${this.config.id}] Auto-executed (L${this.config.autonomyLevel} policy):\n${result.text}${similarContext}`,
          };
        } else {
          const result = await this.delegateToTaskAgent(message, intent);
          response = {
            text: `${result.text}${similarContext}`,
          };
        }

        if (this.storage) {
          await this.storage.appendAudit({
            actorType: "agent",
            actorId: this.config.id,
            action: "task.executed",
            result: "success",
            metadata: {
              agentId: this.config.id,
              project: this.config.projectId || "unknown",
              risk: intent.risk,
              detail: instruction,
              channel: message.channelType,
            },
          });
        }
        break;
      }

      case "link":
        response = await this.handleLink(message, intent);
        if (this.storage) {
          await this.storage.appendAudit({
            actorType: "user",
            actorId: message.channelUserId,
            action: "project.linked",
            result: "success",
            metadata: {
              agentId: this.config.id,
              project: this.config.projectId || "unknown",
              risk: intent.risk,
              detail: `Linked ${intent.params.repo || "unknown"}`,
              channel: message.channelType,
            },
          });
        }
        break;

      case "unlink":
        response = await this.handleUnlink();
        if (this.storage) {
          await this.storage.appendAudit({
            actorType: "user",
            actorId: message.channelUserId,
            action: "project.unlinked",
            result: "success",
            metadata: {
              agentId: this.config.id,
              project: this.config.projectId || "unknown",
              risk: intent.risk,
              detail: "Project unlinked",
              channel: message.channelType,
            },
          });
        }
        break;

      case "deploy": {
        const env =
          (intent.params.environment as "staging" | "production") ||
          "staging";
        if (this.shouldAutoExecute(intent)) {
          // Auto-execute: skip approval, deploy directly
          response = this.deployAgent.executeDeploy(env);

          // Log as autonomous action
          if (this.storage) {
            await this.storage.appendAudit({
              actorType: "agent",
              actorId: this.config.id,
              action: "deploy.auto_executed",
              result: "success",
              metadata: {
                agentId: this.config.id,
                project: this.config.projectId || "unknown",
                risk: intent.risk,
                detail: `Auto-deployed to ${env} (L${this.config.autonomyLevel})`,
                channel: message.channelType,
                environment: env,
                autonomyLevel: this.config.autonomyLevel,
              },
            });
          }
        } else {
          // Normal flow: request approval
          response = await this.deployAgent.handleMessage(message, intent);

          if (this.storage) {
            await this.storage.appendAudit({
              actorType: "agent",
              actorId: this.config.id,
              action: "deploy.requested",
              result: "pending",
              metadata: {
                agentId: this.config.id,
                project: this.config.projectId || "unknown",
                risk: intent.risk,
                detail: `Deploy to ${env}. Waiting approval.`,
                channel: message.channelType,
                environment: env,
              },
            });
          }
        }
        break;
      }

      case "approve":
        response = await this.deployAgent.handleMessage(message, intent);
        if (this.storage) {
          await this.storage.appendAudit({
            actorType: "user",
            actorId: message.channelUserId,
            action: "approval.voted",
            result: "success",
            metadata: {
              agentId: this.config.id,
              project: this.config.projectId || "unknown",
              risk: intent.risk,
              detail: `Approved via ${message.channelType}. Token: ${intent.params.token || "unknown"}`,
              channel: message.channelType,
            },
          });
        }
        break;

      case "rollback": {
        response = await this.deployAgent.handleMessage(message, intent);
        const rollbackEnv = intent.params.environment || "production";
        if (this.storage) {
          await this.storage.appendAudit({
            actorType: "agent",
            actorId: this.config.id,
            action: "rollback.requested",
            result: "pending",
            metadata: {
              agentId: this.config.id,
              project: this.config.projectId || "unknown",
              risk: intent.risk,
              detail: `Rollback ${rollbackEnv}. Requires quorum.`,
              channel: message.channelType,
              environment: rollbackEnv,
            },
          });
        }
        break;
      }

      case "autonomy": {
        const newLevel = parseInt(intent.params.level, 10);
        if (isNaN(newLevel) || newLevel < 0 || newLevel > 5) {
          response = {
            text: `[${this.config.id}] Invalid level. Use L0-L5.`,
          };
        } else {
          // Update config (in-memory). AgentConfig.autonomyLevel is readonly,
          // so we use a cast here intentionally — this is the only mutation point.
          (this.config as { autonomyLevel: number }).autonomyLevel = newLevel;

          // Persist to storage so it survives restarts
          if (this.storage) {
            await this.storage.setMemory(
              this.config.id,
              "autonomyLevel",
              newLevel
            );
          }

          const labels = [
            "Passive",
            "Notify",
            "Suggest",
            "Auto-Low",
            "Auto-Med",
            "Full Auto",
          ];
          response = {
            text: `[${this.config.id}] Autonomy updated to L${newLevel} (${labels[newLevel]}).`,
          };

          if (this.storage) {
            await this.storage.appendAudit({
              actorType: "user",
              actorId: message.channelUserId,
              action: "autonomy.changed",
              result: "success",
              metadata: {
                agentId: this.config.id,
                project: this.config.projectId || "unknown",
                risk: intent.risk,
                detail: `Changed to L${newLevel} (${labels[newLevel]})`,
                channel: message.channelType,
              },
            });
          }
        }
        break;
      }

      case "whoami": {
        const identity = this.identityStore?.resolve(
          message.channelType,
          message.channelUserId,
        );
        if (identity) {
          const channels = Array.from(identity.channelIdentities.entries())
            .map(([type, id]) => `${type}: ${id}`)
            .join(", ");
          response = {
            text: `[${this.config.id}] Identity: ${identity.displayName}\n  Role: ${identity.role}\n  Channels: ${channels}`,
          };
        } else {
          response = {
            text: `[${this.config.id}] Unknown identity. Use: register <your-name> to register.`,
          };
        }
        break;
      }

      case "register": {
        const name = intent.params.name;
        if (!name) {
          response = {
            text: `[${this.config.id}] Usage: register <your-name>`,
          };
        } else if (!this.identityStore) {
          response = {
            text: `[${this.config.id}] Cannot register — no identity store configured.`,
          };
        } else {
          const registered = await this.identityStore.registerUser({
            displayName: name,
            role: "operator",
            channelType: message.channelType,
            channelUserId: message.channelUserId,
          });
          response = {
            text: `[${this.config.id}] Registered: ${registered.displayName} (${message.channelType}:${message.channelUserId})\n  Role: ${registered.role}\n  ID: ${registered.id}`,
          };

          if (this.storage) {
            await this.storage.appendAudit({
              actorType: "user",
              actorId: message.channelUserId,
              action: "identity.registered",
              result: "success",
              metadata: {
                agentId: this.config.id,
                project: this.config.projectId || "unknown",
                risk: intent.risk,
                detail: `Registered as ${name}`,
                channel: message.channelType,
              },
            });
          }
        }
        break;
      }

      case "kill":
        response = {
          text: `[${this.config.id}] Kill switch requires emergency_admin role.\n  (Kill switch coming in Phase 3)`,
        };
        break;

      case "unknown":
      default: {
        // Try smart response with Claude Sonnet for open-ended questions
        const ctx = await this.buildAgentContext();
        const smartResponse = await generateSmartResponse(intent.rawText, ctx, imageUrls);
        if (smartResponse) {
          response = {
            text: `[${this.config.id}] ${smartResponse}`,
          };
          // Store smart conversation in vector memory
          if (this.vectorStore) {
            await this.vectorStore.add({
              agentId: this.config.id,
              content: `Q: ${intent.rawText}\nA: ${smartResponse.slice(0, 200)}`,
              category: "conversation",
              metadata: { type: "smart_response" },
            });
          }
        } else {
          // Fallback to "unknown command"
          response = {
            text: `[${this.config.id}] Unknown command: "${intent.rawText}"\n  Type "help" for available commands.`,
          };
        }
        if (this.storage) {
          await this.storage.appendAudit({
            actorType: "user",
            actorId: message.channelUserId,
            action: "query.asked",
            result: "success",
            metadata: {
              agentId: this.config.id,
              project: this.config.projectId || "unknown",
              risk: intent.risk,
              detail: intent.rawText,
              channel: message.channelType,
            },
          });
        }
        break;
      }
    }

    // Store interaction in vector memory for future semantic search
    if (this.vectorStore) {
      await this.vectorStore.add({
        agentId: this.config.id,
        content: `Command: ${intent.rawText}\nResponse: ${response.text.slice(0, 200)}`,
        category: "conversation",
        metadata: { intent: intent.type, risk: intent.risk },
      });
    }

    this._state = "IDLE";
    return response;
  }

  /**
   * Determine whether an intent should be auto-executed based on the
   * current autonomy level and the intent's risk classification.
   *
   * Safety guardrail: production deploys, rollbacks, and kill are NEVER
   * auto-executed regardless of autonomy level.
   */
  private shouldAutoExecute(intent: ParsedIntent): boolean {
    const level = this.config.autonomyLevel;

    switch (intent.risk) {
      case "low":
        // L3+: auto-execute low risk (status, help, logs, review)
        return level >= 3;
      case "medium":
        // L4+: auto-execute medium risk (instruct, fix, link, unlink)
        return level >= 4;
      case "high":
        // L5 only: auto-execute high risk (staging deploy)
        // NEVER auto-execute production deploys regardless of level
        if (
          intent.type === "deploy" &&
          intent.params.environment === "production"
        ) {
          return false;
        }
        return level >= 5;
      case "critical":
        // NEVER auto-execute critical (prod deploy, rollback, kill)
        return false;
      default:
        return false;
    }
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

    const taskAgent = new TaskAgent(
      {
        id: taskAgentId,
        type: "task",
        projectId: this.config.projectId,
        autonomyLevel: this.config.autonomyLevel,
      },
      this.storage ?? undefined,
    );

    await taskAgent.initialize();
    const result = await taskAgent.handleMessage(message, intent);
    await taskAgent.shutdown();

    return result;
  }

  /**
   * Spawns an ephemeral Review Agent to handle PR review commands.
   * Passes repo info from project config so the Review Agent can
   * fetch real PR data from GitHub.
   */
  private async delegateToReviewAgent(
    message: NormalizedMessage,
    intent: ParsedIntent
  ): Promise<ChannelResponse> {
    this.reviewAgentCounter++;
    const reviewAgentId = `${this.config.id}-review-${this.reviewAgentCounter}`;

    const reviewAgent = new ReviewAgent(
      {
        id: reviewAgentId,
        type: "review",
        projectId: this.config.projectId,
        autonomyLevel: this.config.autonomyLevel,
      },
      this.storage ?? undefined,
    );

    await reviewAgent.initialize();

    // Resolve repo info from project config so the review agent
    // can fetch the actual PR from GitHub.
    let repoOwner: string | undefined;
    let repoName: string | undefined;
    if (this.storage) {
      const config = await this.storage.getProjectConfig(this.config.id);
      if (config) {
        repoOwner = config.repoOwner;
        repoName = config.repoName;
      }
    }

    const prNumber = parseInt(intent.params.prNumber || "0", 10);
    if (!prNumber) {
      await reviewAgent.shutdown();
      return {
        text: `[${this.config.id}] Usage: review PR #<number>\n  Example: review PR #42`,
      };
    }

    const result = await reviewAgent.reviewPR({ prNumber, repoOwner, repoName });
    await reviewAgent.shutdown();

    return result;
  }

  /**
   * Spawns an ephemeral Review Agent for a CI pull_request event.
   * Extracts PR metadata from the CIEvent and runs review logic.
   */
  private async reviewPRFromCIEvent(event: CIEvent): Promise<ChannelResponse> {
    this.reviewAgentCounter++;
    const reviewAgentId = `${this.config.id}-review-${this.reviewAgentCounter}`;

    const reviewAgent = new ReviewAgent(
      {
        id: reviewAgentId,
        type: "review",
        projectId: this.config.projectId,
        autonomyLevel: this.config.autonomyLevel,
      },
      this.storage ?? undefined,
    );

    await reviewAgent.initialize();

    // Resolve repo info from project config for CI-triggered reviews
    let repoOwner: string | undefined;
    let repoName: string | undefined;
    if (this.storage) {
      const config = await this.storage.getProjectConfig(this.config.id);
      if (config) {
        repoOwner = config.repoOwner;
        repoName = config.repoName;
      }
    }

    const result = await reviewAgent.reviewPR({
      prNumber: event.details.prNumber ?? 0,
      repoOwner,
      repoName,
    });

    await reviewAgent.shutdown();

    return result;
  }

  /**
   * Spawns an ephemeral Incident Agent to investigate a CI failure.
   * The Incident Agent analyzes the event and returns an investigation report.
   */
  private async delegateToIncidentAgent(
    event: CIEvent
  ): Promise<ChannelResponse> {
    this.incidentAgentCounter++;
    const incidentAgentId = `${this.config.id}-incident-${this.incidentAgentCounter}`;

    const incidentAgent = new IncidentAgent(
      {
        id: incidentAgentId,
        type: "incident",
        projectId: this.config.projectId,
        autonomyLevel: this.config.autonomyLevel,
      },
      this.storage ?? undefined
    );

    await incidentAgent.initialize();
    const investigation = await incidentAgent.investigate(event);
    const report = incidentAgent.formatReport(investigation);
    await incidentAgent.shutdown();

    return { text: report };
  }

  private handleMemoryStats(): ChannelResponse {
    if (!this.vectorStore) {
      return {
        text: `[${this.config.id}] Memory: no vector store configured.`,
      };
    }

    const stats = this.vectorStore.getStats();
    const categories = ["conversation", "pattern", "code", "incident"];
    const parts = categories
      .filter((c) => (stats.byCategory[c] ?? 0) > 0 || c === "conversation")
      .map(
        (c) =>
          `${c.charAt(0).toUpperCase() + c.slice(1)}: ${stats.byCategory[c] ?? 0}`,
      );

    return {
      text: `[${this.config.id}] Memory: ${stats.total} entries\n  ${parts.join(" | ")}`,
    };
  }

  /**
   * Build context about this agent's current state for the smart responder.
   * Gathers status, recent audit, memory stats, and project info.
   */
  private async buildAgentContext(): Promise<AgentContext> {
    const uptimeMs = Date.now() - this.startedAt.getTime();

    const recentAudit = this.storage
      ? (await this.storage.queryAudit("", 10)).entries.map((e) => ({
          action: e.action,
          detail: String(e.metadata?.detail || e.metadata?.rawText || ""),
          timestamp: e.timestamp.toISOString(),
        }))
      : [];

    const memoryStats = this.vectorStore?.getStats() ?? {
      total: 0,
      byCategory: {},
    };

    let repoUrl: string | undefined;
    if (this.storage) {
      const config = await this.storage.getProjectConfig(this.config.id);
      if (config) repoUrl = config.repoUrl;
    }

    return {
      agentId: this.config.id,
      projectId: this.config.projectId || "unknown",
      repoUrl,
      autonomyLevel: this.config.autonomyLevel,
      tasksHandled: this.tasksHandled,
      uptimeMinutes: Math.floor(uptimeMs / 60000),
      recentAudit,
      memoryStats,
      linkedChannels: [],
    };
  }

  private async handleLogs(intent: ParsedIntent): Promise<ChannelResponse> {
    if (!this.storage) {
      return {
        text: `[${this.config.id}] Recent activity:\n  ${this.tasksHandled} commands handled since ${this.startedAt.toISOString()}\n  (No storage configured — audit log unavailable)`,
      };
    }

    const limit = intent.params.count ? parseInt(intent.params.count, 10) : 10;
    const { entries } = await this.storage.queryAudit("", limit);

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

  private async handleListPRs(
    intent: ParsedIntent,
    message: NormalizedMessage,
  ): Promise<ChannelResponse> {
    // Get project config for repo info
    if (!this.storage) {
      return { text: `[${this.config.id}] No storage configured. Cannot look up linked project.` };
    }

    const config = await this.storage.getProjectConfig(this.config.id);
    if (!config) {
      return { text: `[${this.config.id}] No project linked. Use: link <repo-url>` };
    }

    const github = new GitHubClient();
    if (!github.isConfigured()) {
      return { text: `[${this.config.id}] GitHub not configured. Set GITHUB_TOKEN.` };
    }

    const state = (intent.params.state || "open") as "open" | "closed" | "all";
    const prs = await github.listPRs(config.repoOwner, config.repoName, state);

    await this.storage.appendAudit({
      actorType: "user",
      actorId: message.channelUserId,
      action: "prs.listed",
      result: "success",
      metadata: {
        agentId: this.config.id,
        project: this.config.projectId || "unknown",
        risk: intent.risk,
        detail: `Listed ${prs.length} ${state} PRs`,
        channel: message.channelType,
      },
    });

    if (prs.length === 0) {
      return { text: `[${this.config.id}] No ${state} pull requests in ${config.repoOwner}/${config.repoName}.` };
    }

    const lines = prs.map((pr) => {
      const labels = pr.labels.length > 0 ? ` [${pr.labels.join(", ")}]` : "";
      return `  #${pr.number} ${pr.title} (by ${pr.author})${labels}\n    ${pr.url}`;
    });

    return {
      text: [
        `[${this.config.id}] ${prs.length} ${state} PR(s) in ${config.repoOwner}/${config.repoName}:`,
        ...lines,
      ].join("\n"),
    };
  }

  /**
   * Parse a repo identifier (URL or shorthand) into owner and name.
   * Supports:
   *   - https://github.com/owner/repo
   *   - http://github.com/owner/repo
   *   - owner/repo (shorthand)
   */
  private parseRepoIdentifier(
    repo: string
  ): { owner: string; name: string; url: string } | null {
    // Full GitHub URL
    const urlMatch = repo.match(
      /^https?:\/\/github\.com\/([\w-]+)\/([\w.-]+?)(?:\.git)?$/i
    );
    if (urlMatch) {
      return {
        owner: urlMatch[1],
        name: urlMatch[2],
        url: `https://github.com/${urlMatch[1]}/${urlMatch[2]}`,
      };
    }

    // Shorthand: owner/repo
    const shortMatch = repo.match(/^([\w-]+)\/([\w.-]+)$/);
    if (shortMatch) {
      return {
        owner: shortMatch[1],
        name: shortMatch[2],
        url: `https://github.com/${shortMatch[1]}/${shortMatch[2]}`,
      };
    }

    return null;
  }

  private async handleLink(
    message: NormalizedMessage,
    intent: ParsedIntent
  ): Promise<ChannelResponse> {
    const repoParam = intent.params.repo;
    if (!repoParam) {
      return {
        text: `[${this.config.id}] Usage: link <repo-url>\n  Example: link codespar/codespar\n  Example: link https://github.com/codespar/codespar`,
      };
    }

    const parsed = this.parseRepoIdentifier(repoParam);
    if (!parsed) {
      return {
        text: `[${this.config.id}] Invalid repo format: "${repoParam}"\n  Use: owner/repo or https://github.com/owner/repo`,
      };
    }

    if (!this.storage) {
      return {
        text: `[${this.config.id}] Cannot link project — no storage configured.`,
      };
    }

    const config: ProjectConfig = {
      repoUrl: parsed.url,
      repoOwner: parsed.owner,
      repoName: parsed.name,
      linkedAt: new Date().toISOString(),
      linkedBy: message.channelUserId,
      webhookConfigured: false,
    };

    await this.storage.setProjectConfig(this.config.id, config);

    // Auto-configure GitHub webhook
    const WEBHOOK_BASE_URL =
      process.env.WEBHOOK_BASE_URL ||
      "https://codespar-production.up.railway.app";
    const webhookUrl = `${WEBHOOK_BASE_URL}/webhooks/github`;

    let webhookStatus: string;
    const { GitHubClient } = await import("@codespar/core");
    const github = new GitHubClient();
    if (github.isConfigured()) {
      const webhook = await github.createWebhook(
        parsed.owner,
        parsed.name,
        webhookUrl,
      );
      if (webhook) {
        config.webhookConfigured = true;
        await this.storage.setProjectConfig(this.config.id, config);
        webhookStatus = `\n  \u2713 GitHub webhook configured automatically`;
      } else {
        webhookStatus = `\n  \u26a0 Could not auto-configure webhook (check GITHUB_TOKEN permissions).\n  Manual setup: ${webhookUrl}`;
      }
    } else {
      webhookStatus = `\n  \u26a0 GITHUB_TOKEN not set. Configure webhook manually:\n  URL: ${webhookUrl}`;
    }

    return {
      text: [
        `\u2713 [${this.config.id}] Project linked: ${parsed.owner}/${parsed.name}`,
        `  Repository: ${parsed.url}`,
        `  Agent: ${this.config.id} (L${this.config.autonomyLevel} ${this.autonomyLabel()})`,
        webhookStatus,
      ].join("\n"),
    };
  }

  private async handleUnlink(): Promise<ChannelResponse> {
    if (!this.storage) {
      return {
        text: `[${this.config.id}] Cannot unlink project — no storage configured.`,
      };
    }

    const existing = await this.storage.getProjectConfig(this.config.id);
    if (!existing) {
      return {
        text: `[${this.config.id}] No project linked. Nothing to unlink.`,
      };
    }

    await this.storage.deleteProjectConfig(this.config.id);

    return {
      text: `\u2713 [${this.config.id}] Project unlinked.`,
    };
  }

  private async handleStatus(intent: ParsedIntent): Promise<ChannelResponse> {
    const target = intent.params.target || "all";
    const uptimeMs = Date.now() - this.startedAt.getTime();
    const uptimeMin = Math.floor(uptimeMs / 60000);

    // Fetch project config if storage is available
    let projectLine: string;
    if (this.storage) {
      const projectConfig = await this.storage.getProjectConfig(this.config.id);
      if (projectConfig) {
        projectLine = `Project: ${projectConfig.repoOwner}/${projectConfig.repoName} (${projectConfig.repoUrl})`;
      } else {
        projectLine = `Project: No project linked. Use: link <repo-url>`;
      }
    } else {
      projectLine = `Project: No project linked. Use: link <repo-url>`;
    }

    const agentInfo = [
      `Agent: ${this.config.id}`,
      projectLine,
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

          // Spawn Incident Agent to investigate the failure
          const investigation = await this.delegateToIncidentAgent(event);
          text += `\n\n${investigation.text}`;
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

          // Spawn Review Agent for newly opened PRs
          const reviewResult = await this.reviewPRFromCIEvent(event);
          text += `\n\n${reviewResult.text}`;
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
