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

import { ApprovalManager, VectorStore, IdentityStore, GitHubClient, generateSmartResponse, metrics } from "@codespar/core";
import type { AgentContext } from "@codespar/core";
import { TaskAgent } from "@codespar/agent-task";
import { DeployAgent } from "@codespar/agent-deploy";
import { ReviewAgent } from "@codespar/agent-review";
import { IncidentAgent } from "@codespar/agent-incident";

const COMMANDS_HELP = `Available commands (24):

  Code & Tasks:
    instruct <task>           Execute a coding task (creates PR)
    fix <issue>               Investigate and propose fix
    plan <feature>            Break down a feature into sub-tasks
    lens <question>           Query data and get insights

  Pull Requests:
    review PR #<number>       Review a pull request
    merge PR #<number>        Merge a pull request (squash/rebase)
    prs [open|closed|all]     List pull requests

  DevOps:
    deploy [env]              Trigger deployment
    rollback [env]            Rollback last deploy
    approve [token]           Approve pending action

  Project:
    status [build|agent|all]  Query current status
    link <repo-url>           Link a GitHub repo
    unlink                    Remove current project link
    logs [n]                  Show recent activity
    autonomy [L0-L5]          Set autonomy level
    docs [type]               Generate docs (changelog/api/architecture)
    scan [target]             Tech debt scan (debt/security/quality/all)
    perf [target]             Performance report (report/bundle/latency)

  Identity:
    whoami                    Show your identity
    register <name>           Register your display name
    memory                    Show agent memory stats
    demo [name]               Show a feature demo
    help                      Show this help`;

export class ProjectAgent implements Agent {
  readonly config: AgentConfig;
  private _state: AgentState = "INITIALIZING";
  private startedAt: Date = new Date();
  private tasksHandled: number = 0;
  private taskAgentCounter: number = 0;
  private reviewAgentCounter: number = 0;
  private incidentAgentCounter: number = 0;
  private taskQueue: Array<{
    id: string;
    instruction: string;
    message: NormalizedMessage;
    intent: ParsedIntent;
  }> = [];
  private activeTaskCount = 0;
  private readonly maxConcurrentTasks = 3;
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
    const handlerStart = Date.now();
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
              latency_ms: Date.now() - handlerStart,
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
              latency_ms: Date.now() - handlerStart,
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
              latency_ms: Date.now() - handlerStart,
            },
          });
        }
        break;

      case "logs": {
        // If NLU classified as "logs" but the text is a natural language question
        // (not the literal "logs" command), use smart response instead
        const isNaturalLanguage = intent.confidence < 1.0 && !/^logs(\s+\d+)?$/i.test(intent.rawText);
        if (isNaturalLanguage) {
          const ctx = await this.buildAgentContext();
          const smartResponse = await generateSmartResponse(intent.rawText, ctx, imageUrls);
          if (smartResponse) {
            response = { text: `[${this.config.id}] ${smartResponse}` };
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
                  detail: intent.rawText.slice(0, 200),
                  channel: message.channelType,
                  classifiedBy: "sonnet",
                  latency_ms: Date.now() - handlerStart,
                },
              });
            }
            break;
          }
        }

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
              latency_ms: Date.now() - handlerStart,
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
              latency_ms: Date.now() - handlerStart,
            },
          });
        }
        break;
      }

      case "prs": {
        response = await this.handleListPRs(intent, message);
        break;
      }

      case "merge": {
        response = await this.handleMergePR(message, intent);
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
        const instruction = intent.params.instruction || intent.params.issue || intent.rawText;

        // Self-healing commands from deploy alert buttons
        if (typeof instruction === "string" && instruction.startsWith("investigate-deploy")) {
          // Deep investigation using repo context
          const ctx = await this.buildAgentContext();
          const imageUrls: { url: string; mimeType?: string }[] = [];
          const smartResponse = await generateSmartResponse(
            `Investigate this deploy failure in detail. Check the recent commits, error logs, and suggest a specific code fix. Context: ${instruction}`,
            ctx, imageUrls
          );
          response = {
            text: `[${this.config.id}] ${smartResponse || "Investigation inconclusive. Manual review recommended."}`,
          };
          break;
        }

        if (typeof instruction === "string" && instruction.startsWith("auto-heal")) {
          // Auto-fix: delegate to task agent with the fix instruction
          const healMessage: NormalizedMessage = {
            ...message,
            text: `instruct Fix the deploy failure. Apply the suggested fix from the alert analysis.`,
          };
          const { parseIntent } = await import("@codespar/core");
          const healIntent = await parseIntent(healMessage.text);
          response = await this.delegateToTaskAgent(healMessage, healIntent);
          break;
        }

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
              latency_ms: Date.now() - handlerStart,
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
              latency_ms: Date.now() - handlerStart,
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
              latency_ms: Date.now() - handlerStart,
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
                latency_ms: Date.now() - handlerStart,
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
                latency_ms: Date.now() - handlerStart,
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
              latency_ms: Date.now() - handlerStart,
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
              latency_ms: Date.now() - handlerStart,
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
                latency_ms: Date.now() - handlerStart,
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
                latency_ms: Date.now() - handlerStart,
              },
            });
          }
        }
        break;
      }

      case "lens": {
        response = await this.delegateToLensAgent(message, intent);
        if (this.storage) {
          await this.storage.appendAudit({
            actorType: "user",
            actorId: message.channelUserId,
            action: "data.queried",
            result: "success",
            metadata: {
              agentId: this.config.id,
              project: this.config.projectId || "unknown",
              risk: intent.risk,
              detail: `Lens query: ${(intent.params.question || "").slice(0, 100)}`,
              channel: message.channelType,
              latency_ms: Date.now() - handlerStart,
            },
          });
        }
        break;
      }

      case "demo": {
        response = await this.handleDemo(message, intent);
        break;
      }

      case "docs": {
        const docTarget = intent.params.target || "changelog";
        const ctx = await this.buildAgentContext();

        let docPrompt = "";
        switch (docTarget) {
          case "changelog":
            docPrompt = `Based on the recent activity (deploys, commits, PRs), generate a CHANGELOG entry in Keep a Changelog format:

## [Unreleased] - ${new Date().toISOString().split("T")[0]}
### Added
- (new features from recent deploys)
### Changed
- (modifications from recent commits)
### Fixed
- (bug fixes from recent activity)

Only include entries based on actual activity data. Be specific with descriptions.`;
            break;
          case "api":
            docPrompt = `Based on the project context, generate API documentation in markdown format. List all known endpoints, their methods, parameters, and example responses. Format as a clean API reference.`;
            break;
          case "architecture":
            docPrompt = `Based on the project context, generate an architecture overview. Include: main components, data flow, key technologies, deployment topology. Use markdown with diagrams described in text.`;
            break;
          default:
            docPrompt = `Generate documentation for this project. Include: overview, setup instructions, key features, and architecture summary.`;
        }

        const smartResponse = await generateSmartResponse(docPrompt, ctx, imageUrls);
        response = { text: `[${this.config.id}] ${smartResponse || "Documentation generation requires a linked repo. Use: link owner/repo"}` };

        if (this.storage) {
          await this.storage.appendAudit({
            actorType: "agent",
            actorId: this.config.id,
            action: "docs.generated",
            result: "success",
            metadata: {
              agentId: this.config.id,
              project: this.config.projectId || "unknown",
              risk: "low",
              detail: `Generated ${docTarget} docs`,
              channel: message.channelType,
              latency_ms: Date.now() - handlerStart,
            },
          });
        }
        break;
      }

      case "scan": {
        const scanTarget = intent.params.target || "all";
        const ctx = await this.buildAgentContext();
        const scanPrompt = `Analyze this project for tech debt. Focus on: ${scanTarget === "all" ? "code quality, unused dependencies, TODO/FIXME comments, duplicated code, security issues" : scanTarget}.

Based on the recent activity and project context, identify the top 5 issues and rate each by severity (low/medium/high/critical).

Format as:
## Tech Debt Report — {project}
For each issue:
- **Issue**: description
- **Severity**: low/medium/high/critical
- **File(s)**: affected files
- **Suggested fix**: how to resolve

End with a **Tech Debt Score**: X/100 (lower is better, 0 = no debt)`;

        const scanResponse = await generateSmartResponse(scanPrompt, ctx, imageUrls);
        response = { text: `[${this.config.id}] ${scanResponse || "Scan inconclusive. Try linking a repo first."}` };
        if (this.storage) {
          await this.storage.appendAudit({
            actorType: "agent",
            actorId: this.config.id,
            action: "scan.completed",
            result: "success",
            metadata: {
              agentId: this.config.id,
              project: this.config.projectId || "unknown",
              risk: "low",
              detail: `Tech debt scan (${scanTarget})`,
              channel: message.channelType,
              latency_ms: Date.now() - handlerStart,
            },
          });
        }
        break;
      }

      case "perf": {
        const perfTarget = intent.params.target || "report";
        let perfData = "";
        if (this.storage) {
          const { entries } = await this.storage.queryAudit("", 100, 0);
          const deploys = entries.filter(e => String(e.action).startsWith("deploy."));
          const successDeploys = deploys.filter(e => e.result === "success");
          const failDeploys = deploys.filter(e => e.result === "error");
          const buildDurations = deploys.map(e => Number((e.metadata as Record<string, unknown>)?.buildDurationMs || 0)).filter(d => d > 0);
          const avgBuildTime = buildDurations.length > 0 ? Math.round(buildDurations.reduce((a, b) => a + b, 0) / buildDurations.length / 1000) : 0;
          const apiCalls = entries.filter(e => String(e.action) === "api.claude");
          const latencies = apiCalls.map(e => Number((e.metadata as Record<string, unknown>)?.latency_ms || 0)).filter(l => l > 0);
          const avgLat = latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
          const p95 = latencies.length > 0 ? latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.95)] : 0;
          const totalCost = apiCalls.reduce((sum, e) => sum + Number((e.metadata as Record<string, unknown>)?.cost_usd || 0), 0);
          perfData = `Deploys: ${deploys.length} (${successDeploys.length} ok, ${failDeploys.length} fail), Avg build: ${avgBuildTime}s, API calls: ${apiCalls.length}, Avg latency: ${avgLat}ms (P95: ${p95}ms), Cost: $${totalCost.toFixed(2)}`;
        }
        const ctx = await this.buildAgentContext();
        const perfPrompt = `Generate a performance report. Metrics: ${perfData || "No data yet"}

Format as:
## Performance Report — {project}
### Deploy Health
### API Performance
### Cost Analysis
### Recommendations (3-5 actionable items)

Focus on: ${perfTarget}`;
        const perfResponse = await generateSmartResponse(perfPrompt, ctx, imageUrls);
        response = { text: `[${this.config.id}] ${perfResponse || "Performance data insufficient."}` };
        if (this.storage) {
          await this.storage.appendAudit({
            actorType: "agent",
            actorId: this.config.id,
            action: "perf.reported",
            result: "success",
            metadata: {
              agentId: this.config.id,
              project: this.config.projectId || "unknown",
              risk: "low",
              detail: `Performance report (${perfTarget})`,
              channel: message.channelType,
              latency_ms: Date.now() - handlerStart,
            },
          });
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
              latency_ms: Date.now() - handlerStart,
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

    metrics.increment("agent.tool_calls");
    metrics.observe("agent.tool_latency_ms", Date.now() - handlerStart);

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
   * Run a named demo and return the output as a channel message.
   * Currently supports "mcp-generator". In production this would
   * use the enterprise @codespar-enterprise/mcp-generator package.
   */
  private async handleDemo(
    message: NormalizedMessage,
    intent: ParsedIntent,
  ): Promise<ChannelResponse> {
    const demoParam = (intent.params.demoName || "").trim();
    const onProgress = message.metadata?.onProgress as ((event: { type: string; message: string; code?: string }) => void) | undefined;

    // "demo query <question>" - simulate agent using tools
    if (demoParam.startsWith("query ")) {
      return this.handleDemoQuery(demoParam.slice(6).trim().toLowerCase(), onProgress);
    }

    // "demo mcp-generator" or "demo" - progressive scan and generation
    if (demoParam !== "mcp-generator" && demoParam !== "") {
      return { text: `[${this.config.id}] Available demos:\n  demo mcp-generator\n  demo query <question>` };
    }

    // If we have onProgress (web chat with streaming), show progressively
    if (onProgress) {
      const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

      onProgress({ type: "status", message: "Scanning demo API..." });
      await delay(600);

      onProgress({ type: "status", message: "Found: src/routes/users.ts (5 endpoints)" });
      await delay(400);
      onProgress({ type: "status", message: "Found: src/routes/orders.ts (3 endpoints)" });
      await delay(400);
      onProgress({ type: "status", message: "Found: src/routes/health.ts (1 endpoint)" });
      await delay(300);
      onProgress({ type: "status", message: "9 endpoints discovered" });
      await delay(600);

      onProgress({ type: "status", message: "Generating MCP tools..." });
      await delay(400);

      const tools = [
        "listUsers(page, limit)",
        "getUsersById(id)",
        "createUsers(name, email, role)",
        "updateUsersById(id, name, email)",
        "deleteUsersById(id)",
        "listOrders(status, customerId)",
        "getOrdersById(id)",
        "createOrders(customerId, items, total)",
        "getHealth()",
      ];

      for (const tool of tools) {
        onProgress({ type: "code", message: "", code: `  \u2192 ${tool}\n` });
        await delay(150);
      }

      await delay(400);
      onProgress({ type: "status", message: "\u2705 MCP Server generated: 9 tools ready" });

      // Return the final response with query suggestions
      return {
        text: [
          "MCP Server ready. Now try querying the demo API:",
          "",
          "  demo query how many users do we have?",
          "  demo query create a user named Ana",
          "  demo query show me pending orders",
          "  demo query check system health",
        ].join("\n"),
      };
    }

    // Fallback for non-streaming channels (Slack, WhatsApp): return full text
    const lines = [
      `[${this.config.id}] MCP Generator Demo`,
      "",
      "Scanning demo API (3 files)...",
      "",
      "\u2022 src/routes/users.ts (5 endpoints)",
      "\u2022 src/routes/orders.ts (3 endpoints)",
      "\u2022 src/routes/health.ts (1 endpoint)",
      "",
      "Generating MCP tools...",
      "",
      "  GET    /api/users          \u2192 listUsers(page, limit)",
      "  GET    /api/users/:id      \u2192 getUsersById(id)",
      "  POST   /api/users          \u2192 createUsers(name, email, role)",
      "  PUT    /api/users/:id      \u2192 updateUsersById(id, name, email)",
      "  DELETE /api/users/:id      \u2192 deleteUsersById(id)",
      "  GET    /api/orders         \u2192 listOrders(status, customerId)",
      "  GET    /api/orders/:id     \u2192 getOrdersById(id)",
      "  POST   /api/orders         \u2192 createOrders(customerId, items, total)",
      "  GET    /api/health         \u2192 getHealth()",
      "",
      "\u2705 MCP Server generated: 9 tools ready",
      "",
      "Now try querying the demo API:",
      "  demo query how many users do we have?",
      "  demo query create a user named Ana with email ana@test.com",
      "  demo query show me pending orders",
      "  demo query check system health",
    ];
    return { text: lines.join("\n") };
  }

  private async handleDemoQuery(
    question: string,
    onProgress?: (event: { type: string; message: string; code?: string }) => void,
  ): Promise<ChannelResponse> {
    // Simulate tool selection and execution based on the question
    interface DemoResponse {
      toolName: string;
      method: string;
      path: string;
      params?: Record<string, string>;
      response: unknown;
      answer: string;
    }

    let result: DemoResponse;

    if (question.includes("how many") && question.includes("user") || question.includes("list user") || question.includes("all user")) {
      result = {
        toolName: "listUsers",
        method: "GET",
        path: "/api/users",
        response: {
          users: [
            { id: 1, name: "Ana Silva", email: "ana@company.com", role: "admin" },
            { id: 2, name: "Pedro Santos", email: "pedro@company.com", role: "developer" },
            { id: 3, name: "Maria Costa", email: "maria@company.com", role: "developer" },
          ],
          total: 47,
        },
        answer: "You have 47 registered users. Here are the first 3:\n  1. Ana Silva (admin)\n  2. Pedro Santos (developer)\n  3. Maria Costa (developer)",
      };
    } else if (question.includes("create") && question.includes("user")) {
      // Extract name and email from question
      const nameMatch = question.match(/named?\s+(\w+)/i) || question.match(/user\s+(\w+)/i);
      const emailMatch = question.match(/email\s+(\S+@\S+)/i);
      const name = nameMatch ? nameMatch[1] : "New User";
      const email = emailMatch ? emailMatch[1] : `${name.toLowerCase()}@test.com`;

      result = {
        toolName: "createUsers",
        method: "POST",
        path: "/api/users",
        params: { name, email, role: "developer" },
        response: { id: 48, name, email, role: "developer", createdAt: new Date().toISOString() },
        answer: `User "${name}" created successfully (ID: 48, email: ${email}).`,
      };
    } else if (question.includes("pending") && question.includes("order") || question.includes("order") && question.includes("status")) {
      result = {
        toolName: "listOrders",
        method: "GET",
        path: "/api/orders?status=pending",
        params: { status: "pending" },
        response: {
          orders: [
            { id: "ORD-101", customerId: "C-003", total: 249.99, status: "pending", items: 3 },
            { id: "ORD-108", customerId: "C-017", total: 1299.00, status: "pending", items: 1 },
          ],
        },
        answer: "You have 2 pending orders:\n  \u2022 ORD-101: $249.99 (3 items)\n  \u2022 ORD-108: $1,299.00 (1 item)\n  Total pending: $1,548.99",
      };
    } else if (question.includes("order") && (question.includes("detail") || question.match(/order\s+\d+/) || question.includes("ord-"))) {
      result = {
        toolName: "getOrdersById",
        method: "GET",
        path: "/api/orders/ORD-101",
        params: { id: "ORD-101" },
        response: { id: "ORD-101", customerId: "C-003", customer: "Maria Costa", total: 249.99, status: "pending", items: [{ product: "Widget A", qty: 2, price: 99.99 }, { product: "Widget B", qty: 1, price: 50.01 }] },
        answer: "Order ORD-101:\n  Customer: Maria Costa\n  Status: pending\n  Items:\n    \u2022 Widget A x2 ($99.99 each)\n    \u2022 Widget B x1 ($50.01)\n  Total: $249.99",
      };
    } else if (question.includes("health") || question.includes("status") && !question.includes("order")) {
      result = {
        toolName: "getHealth",
        method: "GET",
        path: "/api/health",
        response: { status: "ok", uptime: 86420, timestamp: new Date().toISOString() },
        answer: "System is healthy. Uptime: 24 hours. All services operational.",
      };
    } else if (question.includes("delete") && question.includes("user")) {
      const idMatch = question.match(/(?:id\s+)?(\d+)/);
      const id = idMatch ? idMatch[1] : "48";
      result = {
        toolName: "deleteUsersById",
        method: "DELETE",
        path: `/api/users/${id}`,
        params: { id },
        response: { deleted: true },
        answer: `User ${id} has been deleted.`,
      };
    } else if (question.includes("update") && question.includes("user")) {
      const nameMatch = question.match(/named?\s+(\w+)/i);
      const name = nameMatch ? nameMatch[1] : "Updated";
      result = {
        toolName: "updateUsersById",
        method: "PUT",
        path: "/api/users/1",
        params: { id: "1", name },
        response: { id: 1, name, email: "ana@company.com", role: "admin", updatedAt: new Date().toISOString() },
        answer: `User 1 updated. Name changed to "${name}".`,
      };
    } else if (question.includes("create") && question.includes("order")) {
      result = {
        toolName: "createOrders",
        method: "POST",
        path: "/api/orders",
        params: { customerId: "C-003", items: "2", total: "199.98" },
        response: { id: "ORD-115", customerId: "C-003", total: 199.98, status: "pending", createdAt: new Date().toISOString() },
        answer: "Order ORD-115 created. Total: $199.98. Status: pending.",
      };
    } else {
      // Unknown query - suggest options
      return {
        text: [
          `[MCP Demo] I can answer questions about users, orders, and system health.`,
          "",
          "Try:",
          '  demo query how many users do we have?',
          '  demo query create a user named Jo\u00e3o',
          '  demo query show pending orders',
          '  demo query order details ORD-101',
          '  demo query check system health',
          '  demo query delete user 48',
        ].join("\n"),
      };
    }

    // If we have onProgress (web chat with streaming), show steps progressively
    if (onProgress) {
      const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

      onProgress({ type: "status", message: `Processing: "${question}"` });
      await delay(500);
      onProgress({ type: "status", message: `Selecting tool: ${result.toolName}` });
      await delay(400);
      onProgress({ type: "status", message: `Calling: ${result.method} ${result.path}` });
      await delay(600);
      onProgress({ type: "status", message: "Response received" });
      await delay(300);
      onProgress({ type: "code", message: "", code: JSON.stringify(result.response, null, 2) });
      await delay(400);

      return {
        text: [
          result.answer,
          "",
          "Try another query or type: demo mcp-generator",
        ].join("\n"),
      };
    }

    // Fallback for non-streaming channels: return full text
    const paramsStr = result.params
      ? Object.entries(result.params).map(([k, v]) => `${k}: "${v}"`).join(", ")
      : "";

    const lines = [
      `[MCP Demo] Processing: "${question}"`,
      "",
      `\u25CB Selecting tool: ${result.toolName}`,
      `\u25CB Calling: ${result.method} ${result.path}`,
      paramsStr ? `  Body: { ${paramsStr} }` : "",
      `\u25CB Response:`,
      "```",
      JSON.stringify(result.response, null, 2),
      "```",
      "",
      result.answer,
      "",
      "Try another query or type: demo mcp-generator",
    ].filter(Boolean);

    return { text: lines.join("\n") };
  }

  /**
   * Spawns an ephemeral Lens Agent to handle data analysis queries.
   */
  private async delegateToLensAgent(
    message: NormalizedMessage,
    intent: ParsedIntent,
  ): Promise<ChannelResponse> {
    const { LensAgent } = await import("@codespar/agent-lens");
    const lensAgent = new LensAgent({
      id: `${this.config.id}-lens-${Date.now()}`,
      type: "lens",
      autonomyLevel: this.config.autonomyLevel,
      projectId: this.config.projectId,
    });
    await lensAgent.initialize();
    return lensAgent.handleMessage(message, intent);
  }

  /**
   * Spawns an ephemeral Task Agent to handle instruct/fix commands.
   * Supports concurrent execution up to maxConcurrentTasks. Excess tasks
   * are queued and executed automatically when a slot opens.
   */
  private async delegateToTaskAgent(
    message: NormalizedMessage,
    intent: ParsedIntent,
  ): Promise<ChannelResponse> {
    const instruction = intent.params.instruction || intent.params.issue || intent.rawText;

    if (this.activeTaskCount >= this.maxConcurrentTasks) {
      this.taskQueue.push({
        id: `queued-${Date.now()}`,
        instruction,
        message,
        intent,
      });
      return {
        text: `[${this.config.id}] Task queued (${this.taskQueue.length} waiting, ${this.activeTaskCount} running). Will execute when a slot opens.`,
      };
    }

    return this.executeTask(message, intent);
  }

  private async executeTask(
    message: NormalizedMessage,
    intent: ParsedIntent,
  ): Promise<ChannelResponse> {
    this.activeTaskCount++;
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

    try {
      await taskAgent.initialize();
      const result = await taskAgent.handleMessage(message, intent);
      await taskAgent.shutdown();
      return result;
    } finally {
      this.activeTaskCount--;
      this.processQueue();
    }
  }

  private processQueue(): void {
    while (this.taskQueue.length > 0 && this.activeTaskCount < this.maxConcurrentTasks) {
      const next = this.taskQueue.shift();
      if (next) {
        // Execute in background without awaiting so we can process more from the queue
        this.executeTask(next.message, next.intent).then((response) => {
          console.log(
            `[${this.config.id}] Queued task completed: ${next.instruction.slice(0, 50)}`,
          );
        });
      }
    }
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
      ? (await this.storage.queryAudit("", 30)).entries.map((e) => ({
          action: e.action,
          detail: String(e.metadata?.detail || e.metadata?.rawText || ""),
          timestamp: e.timestamp.toISOString(),
          repo: String(e.metadata?.repo || ""),
          branch: String(e.metadata?.branch || ""),
          commitSha: String(e.metadata?.commitSha || ""),
          commitMessage: String(e.metadata?.commitMessage || ""),
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

  private async handleMergePR(
    message: NormalizedMessage,
    intent: ParsedIntent,
  ): Promise<ChannelResponse> {
    if (!this.storage) {
      return { text: `[${this.config.id}] No storage configured.` };
    }

    const config = await this.storage.getProjectConfig(this.config.id);
    if (!config) {
      return { text: `[${this.config.id}] No project linked. Use: link <repo-url>` };
    }

    const github = new GitHubClient();
    if (!github.isConfigured()) {
      return { text: `[${this.config.id}] GitHub not configured. Set GITHUB_TOKEN.` };
    }

    const prNumber = intent.params.prNumber ? parseInt(intent.params.prNumber, 10) : 0;
    if (!prNumber) {
      return { text: `[${this.config.id}] Usage: merge PR #<number>\n  Example: merge PR #42` };
    }

    const mergeMethod = (intent.params.mergeMethod || "merge") as "merge" | "squash" | "rebase";

    // Get PR info first
    const pr = await github.getPR(config.repoOwner, config.repoName, prNumber);
    if (!pr) {
      return { text: `[${this.config.id}] PR #${prNumber} not found in ${config.repoOwner}/${config.repoName}.` };
    }

    if (pr.state !== "open") {
      return { text: `[${this.config.id}] PR #${prNumber} is already ${pr.state}.` };
    }

    // Merge
    const result = await github.mergePR(config.repoOwner, config.repoName, prNumber, mergeMethod);

    if (!result) {
      return { text: `[${this.config.id}] Failed to merge PR #${prNumber}.` };
    }

    // Audit
    await this.storage.appendAudit({
      actorType: "user",
      actorId: message.channelUserId,
      action: "pr.merged",
      result: result.merged ? "success" : "failure",
      metadata: {
        agentId: this.config.id,
        project: this.config.projectId || "unknown",
        risk: intent.risk,
        detail: `PR #${prNumber} ${result.merged ? "merged" : "failed"} (${mergeMethod}): ${pr.title}`,
        channel: message.channelType,
      },
    });

    if (result.merged) {
      return {
        text: [
          `[${this.config.id}] PR #${prNumber} merged (${mergeMethod})`,
          `  Title: ${pr.title}`,
          `  Author: ${pr.author}`,
          `  ${pr.url}`,
        ].join("\n"),
      };
    }

    return { text: `[${this.config.id}] Failed to merge PR #${prNumber}: ${result.message}` };
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

    // Recent audit activity
    let recentActivity = "";
    if (this.storage) {
      const { entries } = await this.storage.queryAudit("", 3);
      if (entries.length > 0) {
        const lines = entries.map((e) => {
          const action = e.metadata?.detail || e.action;
          return `  - ${e.result === "success" ? "\u2705" : "\u26A0\uFE0F"} ${action}`;
        });
        recentActivity = `\n\nRecent Activity:\n${lines.join("\n")}`;
      }
    }

    const availableActions = `\n\nAvailable Actions:
  instruct <task>     Create code and open PRs
  fix <issue>         Investigate and fix bugs
  review PR #N        Review pull requests
  merge PR #N         Merge pull requests
  prs                 List open PRs
  plan <feature>      Break down large features
  lens <question>     Query and analyze data
  deploy [env]        Trigger deployments
  help                Show all 20 commands`;

    if (target === "agent" || target === "all") {
      return {
        text: `[${this.config.id}] ## Project Status\n  ${agentInfo}${recentActivity}${availableActions}`,
      };
    }

    return {
      text: `[${this.config.id}] Build status:\n  (CI/CD webhook integration active)`,
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
      orgId: this.config.orgId,
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
