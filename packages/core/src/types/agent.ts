/**
 * Agent interface and lifecycle states.
 * Every agent type (Project, Task, Review, Deploy, Incident, Coordinator)
 * implements this interface.
 */

import type { NormalizedMessage } from "./normalized-message.js";
import type { ChannelResponse } from "./channel-adapter.js";
import type { ParsedIntent } from "./intent.js";

export type AgentType =
  | "project"
  | "task"
  | "review"
  | "deploy"
  | "incident"
  | "coordinator"
  | "planning";

export type AgentState =
  | "INITIALIZING"
  | "IDLE"
  | "ACTIVE"
  | "WAITING_APPROVAL"
  | "SUSPENDED"
  | "ERROR"
  | "TERMINATED";

export type AutonomyLevel = 0 | 1 | 2 | 3 | 4 | 5;

export interface AgentStatus {
  id: string;
  type: AgentType;
  state: AgentState;
  autonomyLevel: AutonomyLevel;
  projectId?: string;
  lastActiveAt?: Date;
  uptimeMs: number;
  tasksHandled: number;
}

export interface AgentConfig {
  id: string;
  type: AgentType;
  projectId?: string;
  autonomyLevel: AutonomyLevel;
}

export interface Agent {
  /** Agent configuration */
  readonly config: AgentConfig;

  /** Current state */
  readonly state: AgentState;

  /** Initialize agent (load context, connect to services) */
  initialize(): Promise<void>;

  /** Handle an incoming message with parsed intent */
  handleMessage(
    message: NormalizedMessage,
    intent: ParsedIntent
  ): Promise<ChannelResponse>;

  /** Get current agent status */
  getStatus(): AgentStatus;

  /** Graceful shutdown */
  shutdown(): Promise<void>;
}
