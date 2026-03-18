/**
 * RBAC — Role-Based Access Control for CodeSpar.
 *
 * Implements the 6-role permission model:
 *   owner > emergency_admin > maintainer > operator > reviewer > read-only
 *
 * Every intent is mapped to a required permission, and every role defines
 * the set of permissions it grants. The check is a simple set-membership
 * lookup — no inheritance chains, no dynamic resolution.
 */

import type { IntentType } from "../types/intent.js";

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export type Role =
  | "owner"
  | "maintainer"
  | "operator"
  | "reviewer"
  | "read-only"
  | "emergency_admin";

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export type Permission =
  | "view_status"
  | "view_diffs"
  | "instruct_agent"
  | "apply_fix"
  | "approve_pr"
  | "merge_pr"
  | "deploy_staging"
  | "deploy_production"
  | "set_autonomy"
  | "configure_policies"
  | "view_activity_log"
  | "link_channel"
  | "invite_members"
  | "view_audit"
  | "kill_switch";

// ---------------------------------------------------------------------------
// Permission matrix
// ---------------------------------------------------------------------------

const ALL_PERMISSIONS: Permission[] = [
  "view_status",
  "view_diffs",
  "instruct_agent",
  "apply_fix",
  "approve_pr",
  "merge_pr",
  "deploy_staging",
  "deploy_production",
  "set_autonomy",
  "configure_policies",
  "view_activity_log",
  "link_channel",
  "invite_members",
  "view_audit",
  "kill_switch",
];

export const ROLE_PERMISSIONS: Record<Role, Set<Permission>> = {
  owner: new Set(ALL_PERMISSIONS),

  emergency_admin: new Set(ALL_PERMISSIONS),

  maintainer: new Set<Permission>([
    "view_status",
    "view_diffs",
    "instruct_agent",
    "apply_fix",
    "approve_pr",
    "merge_pr",
    "deploy_staging",
    "deploy_production",
    "set_autonomy",
    "configure_policies",
    "view_activity_log",
    "link_channel",
  ]),

  operator: new Set<Permission>([
    "view_status",
    "view_diffs",
    "instruct_agent",
    "apply_fix",
    "deploy_staging",
    "set_autonomy", // limited to L0-L2 at runtime
    "view_activity_log",
  ]),

  reviewer: new Set<Permission>([
    "view_status",
    "view_diffs",
    "approve_pr",
    "view_activity_log",
  ]),

  "read-only": new Set<Permission>(["view_status", "view_diffs"]),
};

// ---------------------------------------------------------------------------
// Role hierarchy (used for display / "required role" lookups)
// ---------------------------------------------------------------------------

/** Lower index = more privileged. */
const ROLE_HIERARCHY: Role[] = [
  "owner",
  "emergency_admin",
  "maintainer",
  "operator",
  "reviewer",
  "read-only",
];

// ---------------------------------------------------------------------------
// Intent → Permission mapping
// ---------------------------------------------------------------------------

/**
 * Maps each intent type to the permission it requires.
 * `null` means the intent is always allowed (e.g. unknown / help fallback).
 */
const INTENT_PERMISSION: Record<IntentType, Permission | null> = {
  status: "view_status",
  help: "view_status",
  logs: "view_activity_log",
  instruct: "instruct_agent",
  fix: "apply_fix",
  deploy: "deploy_staging", // upgraded to deploy_production at runtime for prod
  rollback: "deploy_production",
  approve: "approve_pr",
  autonomy: "set_autonomy",
  kill: "kill_switch",
  unknown: null, // always allowed — agent will respond with help text
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Check whether a role has a specific permission. */
export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

/**
 * Check whether a role can execute a given intent.
 *
 * For deploy intents the caller should pass the parsed `environment` param
 * so we can distinguish staging vs production. Defaults to staging.
 *
 * For autonomy intents the caller should pass the `level` param so we can
 * enforce the L0-L2 cap for operators.
 */
export function canExecuteIntent(
  role: Role,
  intentType: IntentType,
  params: Record<string, string> = {},
): boolean {
  const permission = resolvePermissionForIntent(intentType, params);
  if (permission === null) return true;

  // Autonomy L3+ requires owner or emergency_admin
  if (intentType === "autonomy") {
    const level = parseInt(params.level ?? "0", 10);
    if (level >= 3 && role !== "owner" && role !== "emergency_admin") {
      return false;
    }
  }

  return hasPermission(role, permission);
}

/**
 * Return the least-privileged role required to execute an intent.
 *
 * Useful for error messages: "Required: operator+".
 */
export function getRequiredRole(
  intentType: IntentType,
  params: Record<string, string> = {},
): Role {
  const permission = resolvePermissionForIntent(intentType, params);
  if (permission === null) return "read-only";

  // Autonomy L3+ is owner-only
  if (intentType === "autonomy") {
    const level = parseInt(params.level ?? "0", 10);
    if (level >= 3) return "owner";
  }

  // Walk the hierarchy from least to most privileged, return the first that
  // has the permission.
  for (let i = ROLE_HIERARCHY.length - 1; i >= 0; i--) {
    if (ROLE_PERMISSIONS[ROLE_HIERARCHY[i]].has(permission)) {
      return ROLE_HIERARCHY[i];
    }
  }

  // Fallback — shouldn't happen if the matrix is complete
  return "owner";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolvePermissionForIntent(
  intentType: IntentType,
  params: Record<string, string>,
): Permission | null {
  if (intentType === "deploy") {
    const env = params.environment ?? "staging";
    if (env === "production" || env === "prod") {
      return "deploy_production";
    }
    return "deploy_staging";
  }

  return INTENT_PERMISSION[intentType];
}
