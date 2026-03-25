import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApprovalManager } from "../approval-manager.js";
import type { ApprovalRequest } from "../approval-manager.js";

describe("ApprovalManager", () => {
  let manager: ApprovalManager;

  beforeEach(() => {
    manager = new ApprovalManager();
  });

  // ── Creating approval requests ────────────────────────────────
  describe("createRequest", () => {
    it("creates a request with correct fields", () => {
      const request = manager.createRequest({
        type: "deploy",
        description: "Deploy to production",
        requestedBy: "user-1",
        requiredApprovals: 2,
      });

      expect(request.type).toBe("deploy");
      expect(request.description).toBe("Deploy to production");
      expect(request.requestedBy).toBe("user-1");
      expect(request.requiredApprovals).toBe(2);
      expect(request.status).toBe("pending");
      expect(request.votes).toHaveLength(0);
    });

    it("generates a unique ID and short token", () => {
      const r1 = manager.createRequest({
        type: "fix",
        description: "Fix bug",
        requestedBy: "user-1",
        requiredApprovals: 1,
      });
      const r2 = manager.createRequest({
        type: "fix",
        description: "Fix another bug",
        requestedBy: "user-1",
        requiredApprovals: 1,
      });

      expect(r1.id).not.toBe(r2.id);
      expect(r1.token).not.toBe(r2.token);
      expect(r1.token.length).toBe(8);
    });

    it("uses default 10-minute expiry for deploy", () => {
      const before = Date.now();
      const request = manager.createRequest({
        type: "deploy",
        description: "Deploy",
        requestedBy: "user-1",
        requiredApprovals: 1,
      });
      const after = Date.now();

      const expectedMs = 10 * 60 * 1000;
      const expiresAt = request.expiresAt.getTime();
      expect(expiresAt).toBeGreaterThanOrEqual(before + expectedMs - 10);
      expect(expiresAt).toBeLessThanOrEqual(after + expectedMs + 10);
    });

    it("uses 3-minute expiry for rollback", () => {
      const before = Date.now();
      const request = manager.createRequest({
        type: "rollback",
        description: "Rollback",
        requestedBy: "user-1",
        requiredApprovals: 1,
      });

      const expectedMs = 3 * 60 * 1000;
      expect(request.expiresAt.getTime()).toBeGreaterThanOrEqual(before + expectedMs - 10);
    });

    it("accepts custom expiry", () => {
      const before = Date.now();
      const request = manager.createRequest({
        type: "fix",
        description: "Fix",
        requestedBy: "user-1",
        requiredApprovals: 1,
        expiresInMs: 5000,
      });

      const expiresAt = request.expiresAt.getTime();
      expect(expiresAt).toBeGreaterThanOrEqual(before + 4990);
      expect(expiresAt).toBeLessThanOrEqual(before + 5100);
    });
  });

  // ── Voting ────────────────────────────────────────────────────
  describe("voting", () => {
    let request: ApprovalRequest;

    beforeEach(() => {
      request = manager.createRequest({
        type: "deploy",
        description: "Deploy to staging",
        requestedBy: "user-1",
        requiredApprovals: 2,
      });
    });

    it("records an approval vote and returns pending status", () => {
      const result = manager.vote(request.token, "user-2", "slack", "approve");

      expect(result).not.toBeNull();
      expect(result!.status).toBe("pending");
      expect(result!.votesReceived).toBe(1);
      expect(result!.votesRequired).toBe(2);
    });

    it("reaches quorum with enough approval votes", () => {
      manager.vote(request.token, "user-2", "slack", "approve");
      const result = manager.vote(request.token, "user-3", "whatsapp", "approve");

      expect(result).not.toBeNull();
      expect(result!.status).toBe("approved");
      expect(result!.votesReceived).toBe(2);
    });

    it("denies immediately on a single deny vote", () => {
      const result = manager.vote(request.token, "user-2", "slack", "deny");

      expect(result).not.toBeNull();
      expect(result!.status).toBe("denied");
    });

    it("returns null for unknown token", () => {
      const result = manager.vote("nonexistent", "user-2", "slack", "approve");
      expect(result).toBeNull();
    });

    it("blocks duplicate votes from the same user", () => {
      manager.vote(request.token, "user-2", "slack", "approve");
      const duplicate = manager.vote(request.token, "user-2", "slack", "approve");

      expect(duplicate).toBeNull();
    });

    it("blocks self-approval when quorum > 1", () => {
      const result = manager.vote(request.token, "user-1", "slack", "approve");
      expect(result).toBeNull();
    });

    it("allows self-approval when quorum = 1", () => {
      const singleRequest = manager.createRequest({
        type: "fix",
        description: "Quick fix",
        requestedBy: "user-1",
        requiredApprovals: 1,
      });

      const result = manager.vote(singleRequest.token, "user-1", "cli", "approve");

      expect(result).not.toBeNull();
      expect(result!.status).toBe("approved");
    });

    it("returns null when voting on already-approved request", () => {
      manager.vote(request.token, "user-2", "slack", "approve");
      manager.vote(request.token, "user-3", "slack", "approve");
      // Request is now approved
      const result = manager.vote(request.token, "user-4", "slack", "approve");
      expect(result).toBeNull();
    });

    it("returns null when voting on already-denied request", () => {
      manager.vote(request.token, "user-2", "slack", "deny");
      // Request is now denied
      const result = manager.vote(request.token, "user-3", "slack", "approve");
      expect(result).toBeNull();
    });
  });

  // ── Expiration ────────────────────────────────────────────────
  describe("expiration", () => {
    it("marks expired requests when voting after deadline", async () => {
      const request = manager.createRequest({
        type: "deploy",
        description: "Deploy",
        requestedBy: "user-1",
        requiredApprovals: 1,
        expiresInMs: 1, // expires almost immediately
      });

      // Wait for expiration
      await new Promise((r) => setTimeout(r, 10));
      const result = manager.vote(request.token, "user-2", "slack", "approve");
      // The vote call should detect expiration and return null
      expect(result).toBeNull();
    });

    it("getPending excludes expired requests", async () => {
      manager.createRequest({
        type: "deploy",
        description: "Deploy",
        requestedBy: "user-1",
        requiredApprovals: 1,
        expiresInMs: 1, // expires immediately
      });

      // Wait for expiration
      await new Promise((r) => setTimeout(r, 10));
      const pending = manager.getPending();
      expect(pending).toHaveLength(0);
    });

    it("getPending includes non-expired requests", () => {
      manager.createRequest({
        type: "deploy",
        description: "Deploy",
        requestedBy: "user-1",
        requiredApprovals: 1,
        expiresInMs: 60_000,
      });

      const pending = manager.getPending();
      expect(pending).toHaveLength(1);
    });
  });

  // ── getByToken ────────────────────────────────────────────────
  describe("getByToken", () => {
    it("returns request by its token", () => {
      const created = manager.createRequest({
        type: "fix",
        description: "Fix",
        requestedBy: "user-1",
        requiredApprovals: 1,
      });

      const found = manager.getByToken(created.token);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
    });

    it("returns null for unknown token", () => {
      const found = manager.getByToken("unknown-token");
      expect(found).toBeNull();
    });
  });

  // ── Cross-channel voting ──────────────────────────────────────
  describe("cross-channel voting", () => {
    it("accepts votes from different channels", () => {
      const request = manager.createRequest({
        type: "deploy",
        description: "Deploy to production",
        requestedBy: "user-1",
        requiredApprovals: 2,
      });

      const vote1 = manager.vote(request.token, "user-2", "whatsapp", "approve");
      const vote2 = manager.vote(request.token, "user-3", "slack", "approve");

      expect(vote1!.status).toBe("pending");
      expect(vote2!.status).toBe("approved");

      // Verify the stored request has votes from both channels
      const stored = manager.getByToken(request.token);
      expect(stored!.votes).toHaveLength(2);
      expect(stored!.votes[0].channelType).toBe("whatsapp");
      expect(stored!.votes[1].channelType).toBe("slack");
    });
  });
});
