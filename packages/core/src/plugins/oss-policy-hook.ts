import type { PolicyDecision, PolicyHook } from "./types.js";
import {
  canonicalizeToolName,
  FUND_TRANSFER_PATTERN,
  DENY_LIST_PATTERNS,
} from "./deny-list-constants.js";

/**
 * OSS reference implementation of PolicyHook.
 *
 * Enforces the five non-overridable categories from the platform safety
 * contract. All five categories return { allowed: false, requiresApproval: true }
 * regardless of autonomy level or any other configuration. No code path
 * overrides these decisions.
 *
 * Tool names are canonicalized before comparison (see canonicalizeToolName)
 * to prevent bypasses via case variation, Unicode lookalikes, or versioning
 * suffixes.
 *
 * Fund-transfer tools with undefined estimatedCost are also denied, because
 * the amount cannot be verified against the configured cap.
 */
export class OSSPolicyHook implements PolicyHook {
  evaluate(agentId: string, toolName: string, estimatedCost?: number): PolicyDecision {
    const canonical = canonicalizeToolName(toolName);

    // Undefined cost on a fund-transfer tool is treated as a cap violation
    // because without a known amount we cannot confirm it is below the limit.
    if (estimatedCost === undefined && FUND_TRANSFER_PATTERN.test(canonical)) {
      return {
        allowed: false,
        requiresApproval: true,
        reason: `Fund-transfer tool "${toolName}" requires a known estimated cost for cap verification.`,
      };
    }

    for (const pattern of DENY_LIST_PATTERNS) {
      if (pattern.test(canonical)) {
        return {
          allowed: false,
          requiresApproval: true,
          reason: `Tool "${toolName}" matches a non-overridable deny-list category and always requires human approval.`,
        };
      }
    }

    return { allowed: true };
  }
}
