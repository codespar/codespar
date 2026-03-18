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

    const intent = parseIntent(message.text);

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

    // For MVP: route to first available agent
    // Future: resolve project from channel mapping
    const agent = this.resolveAgent(message.channelId);
    if (!agent) {
      return {
        text: `[codespar] No agent linked to this channel. Use \`link <repo-url>\` to connect a project.`,
      };
    }

    return agent.handleMessage(message, intent);
  }

  /** Resolve which agent handles this channel */
  private resolveAgent(channelId: string): Agent | undefined {
    // MVP: return first registered agent
    // Future: lookup channel_links table for channel → project → agent mapping
    const firstEntry = this.agents.entries().next();
    return firstEntry.done ? undefined : firstEntry.value[1];
  }

  /** Get all registered agents */
  getAgents(): Map<string, Agent> {
    return new Map(this.agents);
  }
}
