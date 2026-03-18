/**
 * ApprovalManager — Centralized approval workflow for gated actions.
 *
 * Supports quorum-based voting, expiration, and self-approval blocking.
 * Used by Deploy Agent and Project Agent for deploy, rollback, and fix approvals.
 */

import { randomUUID } from "node:crypto";

export interface ApprovalRequest {
  id: string;
  /** Short token for "@codespar approve <token>" */
  token: string;
  type: "deploy" | "fix" | "rollback";
  description: string;
  requestedBy: string;
  requiredApprovals: number;
  votes: Array<{
    userId: string;
    channelType: string;
    vote: "approve" | "deny";
    timestamp: Date;
  }>;
  status: "pending" | "approved" | "denied" | "expired";
  expiresAt: Date;
  createdAt: Date;
}

export interface VoteResult {
  status: "approved" | "denied" | "pending";
  votesReceived: number;
  votesRequired: number;
}

export class ApprovalManager {
  private requests: Map<string, ApprovalRequest> = new Map();

  /**
   * Create a new approval request with a short token.
   */
  createRequest(params: {
    type: ApprovalRequest["type"];
    description: string;
    requestedBy: string;
    requiredApprovals: number;
    expiresInMs?: number;
  }): ApprovalRequest {
    const defaultExpiry =
      params.type === "rollback" ? 3 * 60 * 1000 : 10 * 60 * 1000;
    const expiresInMs = params.expiresInMs ?? defaultExpiry;

    const id = randomUUID();
    const token = id.slice(0, 8);

    const request: ApprovalRequest = {
      id,
      token,
      type: params.type,
      description: params.description,
      requestedBy: params.requestedBy,
      requiredApprovals: params.requiredApprovals,
      votes: [],
      status: "pending",
      expiresAt: new Date(Date.now() + expiresInMs),
      createdAt: new Date(),
    };

    this.requests.set(token, request);
    return request;
  }

  /**
   * Cast a vote on an approval request.
   * Returns null if token not found or request is not pending.
   * Blocks self-approval when quorum > 1.
   */
  vote(
    token: string,
    userId: string,
    channelType: string,
    vote: "approve" | "deny"
  ): VoteResult | null {
    const request = this.requests.get(token);
    if (!request) {
      return null;
    }

    // Expire if past deadline
    if (request.status === "pending" && new Date() > request.expiresAt) {
      request.status = "expired";
    }

    if (request.status !== "pending") {
      return null;
    }

    // Block self-approval when quorum > 1
    if (request.requiredApprovals > 1 && userId === request.requestedBy) {
      return null;
    }

    // Prevent duplicate votes from the same user
    const alreadyVoted = request.votes.some((v) => v.userId === userId);
    if (alreadyVoted) {
      return null;
    }

    request.votes.push({
      userId,
      channelType,
      vote,
      timestamp: new Date(),
    });

    // Check for denial
    const denyCount = request.votes.filter((v) => v.vote === "deny").length;
    if (denyCount > 0) {
      request.status = "denied";
      return {
        status: "denied",
        votesReceived: request.votes.length,
        votesRequired: request.requiredApprovals,
      };
    }

    // Check if quorum met
    const approveCount = request.votes.filter(
      (v) => v.vote === "approve"
    ).length;
    if (approveCount >= request.requiredApprovals) {
      request.status = "approved";
      return {
        status: "approved",
        votesReceived: approveCount,
        votesRequired: request.requiredApprovals,
      };
    }

    return {
      status: "pending",
      votesReceived: approveCount,
      votesRequired: request.requiredApprovals,
    };
  }

  /**
   * Get all pending (non-expired) approval requests.
   */
  getPending(): ApprovalRequest[] {
    const now = new Date();
    const results: ApprovalRequest[] = [];

    for (const request of this.requests.values()) {
      if (request.status === "pending" && now <= request.expiresAt) {
        results.push(request);
      } else if (request.status === "pending" && now > request.expiresAt) {
        request.status = "expired";
      }
    }

    return results;
  }

  /**
   * Look up an approval request by its short token.
   */
  getByToken(token: string): ApprovalRequest | null {
    return this.requests.get(token) ?? null;
  }
}
