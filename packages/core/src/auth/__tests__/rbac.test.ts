import { describe, it, expect } from "vitest";
import {
  canExecuteIntent,
  getRequiredRole,
  hasPermission,
  ROLE_PERMISSIONS,
} from "../rbac.js";
import type { Role } from "../rbac.js";

describe("RBAC — Role-Based Access Control", () => {
  // ── Role existence ──────────────────────────────────────────────
  describe("role definitions", () => {
    const expectedRoles: Role[] = [
      "owner",
      "emergency_admin",
      "maintainer",
      "operator",
      "reviewer",
      "read-only",
    ];

    it("has all 6 roles defined", () => {
      const roles = Object.keys(ROLE_PERMISSIONS);
      expect(roles).toHaveLength(6);
      for (const role of expectedRoles) {
        expect(ROLE_PERMISSIONS).toHaveProperty(role);
      }
    });

    it("owner has all permissions", () => {
      expect(ROLE_PERMISSIONS.owner.size).toBe(15);
    });

    it("emergency_admin has all permissions", () => {
      expect(ROLE_PERMISSIONS.emergency_admin.size).toBe(15);
    });

    it("read-only has only view_status and view_diffs", () => {
      const perms = ROLE_PERMISSIONS["read-only"];
      expect(perms.size).toBe(2);
      expect(perms.has("view_status")).toBe(true);
      expect(perms.has("view_diffs")).toBe(true);
    });

    it("reviewer has view_status, view_diffs, approve_pr, view_activity_log", () => {
      const perms = ROLE_PERMISSIONS.reviewer;
      expect(perms.size).toBe(4);
      expect(perms.has("approve_pr")).toBe(true);
      expect(perms.has("view_activity_log")).toBe(true);
    });

    it("operator has instruct_agent and apply_fix", () => {
      const perms = ROLE_PERMISSIONS.operator;
      expect(perms.has("instruct_agent")).toBe(true);
      expect(perms.has("apply_fix")).toBe(true);
      expect(perms.has("deploy_staging")).toBe(true);
    });
  });

  // ── hasPermission ───────────────────────────────────────────────
  describe("hasPermission", () => {
    it("owner has kill_switch", () => {
      expect(hasPermission("owner", "kill_switch")).toBe(true);
    });

    it("read-only does not have kill_switch", () => {
      expect(hasPermission("read-only", "kill_switch")).toBe(false);
    });

    it("operator does not have deploy_production", () => {
      expect(hasPermission("operator", "deploy_production")).toBe(false);
    });
  });

  // ── canExecuteIntent ───────────────────────────────────────────
  describe("canExecuteIntent", () => {
    it("owner can deploy", () => {
      expect(canExecuteIntent("owner", "deploy")).toBe(true);
    });

    it("read-only cannot deploy", () => {
      expect(canExecuteIntent("read-only", "deploy")).toBe(false);
    });

    it("reviewer can review", () => {
      expect(canExecuteIntent("reviewer", "review")).toBe(true);
    });

    it("operator can instruct", () => {
      expect(canExecuteIntent("operator", "instruct")).toBe(true);
    });

    it("read-only can view status", () => {
      expect(canExecuteIntent("read-only", "status")).toBe(true);
    });

    it("read-only cannot kill", () => {
      expect(canExecuteIntent("read-only", "kill")).toBe(false);
    });

    it("anyone can use whoami (null permission)", () => {
      expect(canExecuteIntent("read-only", "whoami")).toBe(true);
    });

    it("anyone can use register (null permission)", () => {
      expect(canExecuteIntent("read-only", "register")).toBe(true);
    });

    it("operator cannot deploy to production", () => {
      expect(
        canExecuteIntent("operator", "deploy", { environment: "production" }),
      ).toBe(false);
    });

    it("maintainer can deploy to production", () => {
      expect(
        canExecuteIntent("maintainer", "deploy", {
          environment: "production",
        }),
      ).toBe(true);
    });

    it("operator can deploy to staging", () => {
      expect(
        canExecuteIntent("operator", "deploy", { environment: "staging" }),
      ).toBe(true);
    });

    // Autonomy L3+ restrictions
    it("operator cannot set autonomy L3", () => {
      expect(
        canExecuteIntent("operator", "autonomy", { level: "3" }),
      ).toBe(false);
    });

    it("owner can set autonomy L3", () => {
      expect(
        canExecuteIntent("owner", "autonomy", { level: "3" }),
      ).toBe(true);
    });

    it("operator can set autonomy L2", () => {
      expect(
        canExecuteIntent("operator", "autonomy", { level: "2" }),
      ).toBe(true);
    });
  });

  // ── getRequiredRole ────────────────────────────────────────────
  describe("getRequiredRole", () => {
    it("returns read-only for whoami (null permission)", () => {
      expect(getRequiredRole("whoami")).toBe("read-only");
    });

    it("returns a role with deploy_staging permission for deploy", () => {
      const role = getRequiredRole("deploy");
      // operator is the least-privileged role with deploy_staging
      expect(role).toBe("operator");
    });

    it("returns owner for autonomy L5", () => {
      expect(getRequiredRole("autonomy", { level: "5" })).toBe("owner");
    });

    it("returns a role for deploy production", () => {
      const role = getRequiredRole("deploy", { environment: "production" });
      // maintainer is the least-privileged with deploy_production
      expect(role).toBe("maintainer");
    });

    it("returns a role for kill", () => {
      const role = getRequiredRole("kill");
      // Only owner and emergency_admin have kill_switch.
      // Walking from least to most privileged, emergency_admin is found first
      // (it's index 1), but the code walks from the end (read-only → owner),
      // so the first match is emergency_admin.
      expect(["owner", "emergency_admin"]).toContain(role);
    });
  });
});
