/**
 * Message Router — Routes normalized messages to the correct agent.
 *
 * Flow: NormalizedMessage → parse intent → RBAC check → find agent → agent.handleMessage()
 */

import type { NormalizedMessage } from "../types/normalized-message.js";
import type { Agent } from "../types/agent.js";
import type { ChannelResponse } from "../types/channel-adapter.js";
import { parseIntent } from "./intent-parser.js";
import { canExecuteIntent, getRequiredRole } from "../auth/rbac.js";
import { IdentityResolver } from "../auth/identity.js";

export class MessageRouter {
  private agents: Map<string, Agent> = new Map();
  private identityResolver: IdentityResolver | null;

  constructor(identityResolver?: IdentityResolver) {
    this.identityResolver = identityResolver ?? null;
  }

  /** Register an agent for routing */
  registerAgent(projectId: string, agent: Agent): void {
    this.agents.set(projectId, agent);
  }

  /** Remove an agent */
  unregisterAgent(projectId: string): void {
    this.agents.delete(projectId);
  }

  /** Set or replace the identity resolver (useful for late initialisation). */
  setIdentityResolver(resolver: IdentityResolver): void {
    this.identityResolver = resolver;
  }

  /** Route a message to the appropriate agent */
  async route(message: NormalizedMessage): Promise<ChannelResponse | null> {
    // Only process messages that mention the bot or are DMs
    if (!message.isMentioningBot && !message.isDM) {
      return null;
    }

    const intent = await parseIntent(message.text);

    // ---- RBAC check ----
    if (this.identityResolver) {
      const role = this.identityResolver.getRole(
        message.channelType,
        message.channelUserId,
      );

      if (!canExecuteIntent(role, intent.type, intent.params)) {
        const requiredRole = getRequiredRole(intent.type, intent.params);
        return {
          text: `[codespar] Permission denied. Your role: ${role}. Required: ${requiredRole}+.`,
        };
      }
    }

    // ---- Multi-project routing ----
    const words = message.text.trim().split(/\s+/);
    const firstWord = words[0]?.toLowerCase();

    // "all <command>" → route to coordinator for cross-project aggregation
    if (firstWord === "all") {
      const coordinator = this.findCoordinator();
      if (coordinator) {
        // Pass "all <command>" as-is so coordinator handles aggregation
        return coordinator.handleMessage(message, intent);
      }
    }

    // Check if first word matches a project alias or partial project ID
    const agentByAlias = this.findAgentByAlias(firstWord);
    if (agentByAlias) {
      const subText = words.slice(1).join(" ");
      if (!subText) {
        // Bare alias with no command — treat as status
        const subIntent = await parseIntent("status");
        return agentByAlias.handleMessage(
          { ...message, text: "status" },
          subIntent,
        );
      }
      const subIntent = await parseIntent(subText);
      return agentByAlias.handleMessage(
        { ...message, text: subText },
        subIntent,
      );
    }

    // Single project → route directly (skip coordinator)
    const projectAgents = this.getProjectAgents();
    if (projectAgents.length === 1) {
      return projectAgents[0].handleMessage(message, intent);
    }

    // Multiple projects, no alias specified → ask for clarification
    if (projectAgents.length > 1) {
      const aliases = Array.from(this.agents.entries())
        .filter(([key]) => key !== "_coordinator")
        .map(([key]) => key)
        .join(" | ");
      const exampleAlias = Array.from(this.agents.keys()).find(
        (k) => k !== "_coordinator",
      );
      return {
        text: `[codespar] Multiple projects registered. Specify which one:\n  ${aliases}\n\nExample: @codespar ${exampleAlias} status`,
      };
    }

    return {
      text: "[codespar] No projects configured. Use the dashboard to add one.",
    };
  }

  /** Find the coordinator agent (registered under "_coordinator") */
  private findCoordinator(): Agent | undefined {
    return this.agents.get("_coordinator");
  }

  /** Known command words that should never be treated as project aliases */
  private static readonly RESERVED_WORDS = new Set([
    "status", "help", "instruct", "fix", "deploy", "rollback",
    "approve", "autonomy", "logs", "link", "unlink", "review", "context", "memory", "kill",
  ]);

  /** Find a project agent by alias, partial project ID, or repo name fragment */
  private findAgentByAlias(alias: string | undefined): Agent | undefined {
    if (!alias) return undefined;

    // Exact match on registration key (but not reserved commands or coordinator)
    if (alias !== "_coordinator" && this.agents.has(alias)) {
      return this.agents.get(alias);
    }

    // Never treat known command words as partial project aliases
    if (MessageRouter.RESERVED_WORDS.has(alias)) return undefined;

    // Partial match: alias is a substring of the project key or agent ID
    for (const [key, agent] of this.agents) {
      if (key === "_coordinator") continue;
      if (key.includes(alias) || agent.config.id.includes(alias)) {
        return agent;
      }
    }

    return undefined;
  }

  /** Get only project-type agents (excludes coordinator) */
  private getProjectAgents(): Agent[] {
    return Array.from(this.agents.entries())
      .filter(([key]) => key !== "_coordinator")
      .map(([, agent]) => agent)
      .filter((a) => a.config.type === "project");
  }

  /** Get all registered agents */
  getAgents(): Map<string, Agent> {
    return new Map(this.agents);
  }
}
