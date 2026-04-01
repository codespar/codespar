/**
 * A2A (Agent-to-Agent) protocol types for inbound task handling.
 *
 * Phase 2: Accept incoming task requests from external agents.
 * External agents discover skills via Agent Cards (Phase 1),
 * then submit tasks to the /a2a/tasks endpoint.
 */

export interface A2ATaskRequest {
  id: string;
  skill: string; // skill ID from Agent Card (e.g., "task.code-execution", "review.pr-analysis")
  input: {
    text: string;
    attachments?: Array<{ type: string; url?: string; content?: string }>;
  };
  metadata?: {
    callerAgent?: string; // Agent Card URL of the caller
    callbackUrl?: string; // URL to POST results to
    priority?: "low" | "normal" | "high";
  };
}

export type A2ATaskStatus =
  | "submitted"
  | "working"
  | "completed"
  | "failed"
  | "cancelled";

export interface A2ATaskResponse {
  id: string;
  status: A2ATaskStatus;
  skill: string;
  agentType?: string;
  result?: {
    text?: string;
    artifacts?: Array<{ type: string; content: string; title?: string }>;
  };
  error?: { code: string; message: string };
  createdAt: number;
  updatedAt: number;
}
