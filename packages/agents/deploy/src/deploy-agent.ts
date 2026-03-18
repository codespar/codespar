/**
 * Deploy Agent — Orchestrates deployments with approval workflows.
 *
 * Responsibilities:
 * - Handles deploy, approve, and rollback intents
 * - Enforces quorum: 1 approval for staging, 2 for production
 * - Tracks deploy history
 * - Simulates deployment execution (MVP)
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

import { ApprovalManager } from "@codespar/core";
import type { ApprovalRequest } from "@codespar/core";

export interface DeployRequest {
  id: string;
  environment: "staging" | "production";
  requestedBy: string;
  requestedAt: Date;
  status:
    | "pending_approval"
    | "approved"
    | "deploying"
    | "deployed"
    | "failed"
    | "rolled_back";
  approvals: Array<{ userId: string; channel: string; timestamp: Date }>;
  requiredApprovals: number;
  approvalToken: string;
}

export class DeployAgent implements Agent {
  readonly config: AgentConfig;
  private _state: AgentState = "INITIALIZING";
  private startedAt: Date = new Date();
  private tasksHandled: number = 0;
  private deployHistory: DeployRequest[] = [];
  private approvalManager: ApprovalManager;

  /** Map approval tokens to DeployRequest ids for lookups */
  private tokenToDeployId: Map<string, string> = new Map();

  constructor(config: AgentConfig, approvalManager: ApprovalManager) {
    this.config = {
      ...config,
      type: "deploy",
    };
    this.approvalManager = approvalManager;
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

    switch (intent.type) {
      case "deploy":
        response = this.handleDeploy(message, intent);
        break;

      case "approve":
        response = this.handleApprove(message, intent);
        break;

      case "rollback":
        response = this.handleRollback(message, intent);
        break;

      default:
        response = {
          text: `[${this.config.id}] Deploy Agent does not handle "${intent.type}" intents.`,
        };
    }

    this._state = "IDLE";
    return response;
  }

  private handleDeploy(
    message: NormalizedMessage,
    intent: ParsedIntent
  ): ChannelResponse {
    const env =
      (intent.params.environment as "staging" | "production") || "staging";
    const requiredApprovals = env === "production" ? 2 : 1;

    const approval = this.approvalManager.createRequest({
      type: "deploy",
      description: `Deploy to ${env}`,
      requestedBy: message.channelUserId,
      requiredApprovals,
    });

    const deployRequest: DeployRequest = {
      id: approval.id,
      environment: env,
      requestedBy: message.channelUserId,
      requestedAt: new Date(),
      status: "pending_approval",
      approvals: [],
      requiredApprovals,
      approvalToken: approval.token,
    };

    this.deployHistory.push(deployRequest);
    this.tokenToDeployId.set(approval.token, deployRequest.id);

    const expiresIn = env === "production" ? "10 minutes" : "10 minutes";
    return {
      text: `[${this.config.id}] Deploy to ${env} requested.\n  Requires ${requiredApprovals} approval(s).\n  Approve with: @codespar approve ${approval.token}\n  Expires in ${expiresIn}.`,
    };
  }

  private handleApprove(
    message: NormalizedMessage,
    intent: ParsedIntent
  ): ChannelResponse {
    const token = intent.params.token;
    if (!token) {
      return {
        text: `[${this.config.id}] Missing approval token. Usage: @codespar approve <token>`,
      };
    }

    const result = this.approvalManager.vote(
      token,
      message.channelUserId,
      message.channelType,
      "approve"
    );

    if (!result) {
      return {
        text: `[${this.config.id}] Approval failed: token not found, expired, already voted, or self-approval blocked.`,
      };
    }

    const deployId = this.tokenToDeployId.get(token);
    const deploy = deployId
      ? this.deployHistory.find((d) => d.id === deployId)
      : undefined;

    if (result.status === "approved") {
      // Quorum met — simulate deployment
      if (deploy) {
        deploy.status = "deploying";
        deploy.approvals.push({
          userId: message.channelUserId,
          channel: message.channelType,
          timestamp: new Date(),
        });
        // Simulate successful deployment
        deploy.status = "deployed";
      }
      return {
        text: `[${this.config.id}] Approval ${result.votesReceived}/${result.votesRequired} — quorum met. Deploying${deploy ? ` to ${deploy.environment}` : ""}...\n  Deploy complete.`,
      };
    }

    if (result.status === "denied") {
      if (deploy) {
        deploy.status = "failed";
      }
      return {
        text: `[${this.config.id}] Deploy denied.`,
      };
    }

    // Pending — still waiting for more approvals
    if (deploy) {
      deploy.approvals.push({
        userId: message.channelUserId,
        channel: message.channelType,
        timestamp: new Date(),
      });
    }
    return {
      text: `[${this.config.id}] Approval recorded. ${result.votesReceived}/${result.votesRequired} required.`,
    };
  }

  private handleRollback(
    message: NormalizedMessage,
    intent: ParsedIntent
  ): ChannelResponse {
    const requiredApprovals = 2;

    const approval = this.approvalManager.createRequest({
      type: "rollback",
      description: `Rollback ${intent.params.environment || "production"}`,
      requestedBy: message.channelUserId,
      requiredApprovals,
      expiresInMs: 3 * 60 * 1000, // 3 minutes for rollback
    });

    return {
      text: `[${this.config.id}] Rollback requested.\n  Requires ${requiredApprovals} approvals (quorum).\n  Approve with: @codespar approve ${approval.token}\n  Expires in 3 minutes.`,
    };
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
