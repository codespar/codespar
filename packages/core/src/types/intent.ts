/**
 * Intent types for the message parser.
 * MVP uses regex. v1 will use Claude Haiku NLU.
 */

export type IntentType =
  | "status"
  | "help"
  | "instruct"
  | "fix"
  | "deploy"
  | "rollback"
  | "approve"
  | "autonomy"
  | "logs"
  | "link"
  | "unlink"
  | "review"
  | "context"
  | "kill"
  | "whoami"
  | "register"
  | "prs"
  | "merge"
  | "plan"
  | "lens"
  | "demo"
  | "docs"
  | "scan"
  | "perf"
  | "spec"
  | "unknown";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface ParsedIntent {
  /** Classified intent */
  type: IntentType;

  /** Risk level of this action */
  risk: RiskLevel;

  /** Extracted parameters */
  params: Record<string, string>;

  /** Original raw text */
  rawText: string;

  /** Confidence score (0-1). Regex parser always returns 1.0 */
  confidence: number;
}

/** Map intent types to their risk levels */
export const INTENT_RISK: Record<IntentType, RiskLevel> = {
  status: "low",
  help: "low",
  logs: "low",
  instruct: "medium",
  fix: "medium",
  autonomy: "medium",
  approve: "medium",
  link: "medium",
  unlink: "medium",
  review: "low",
  context: "low",
  whoami: "low",
  register: "low",
  prs: "low",
  merge: "medium",
  plan: "medium",
  lens: "low",
  demo: "low",
  docs: "low",
  scan: "low",
  perf: "low",
  spec: "low",
  deploy: "high",
  rollback: "critical",
  kill: "critical",
  unknown: "low",
};
