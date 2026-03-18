/**
 * Message Router — Routes normalized messages to the correct agent.
 *
 * Flow: NormalizedMessage → parse intent → find agent → agent.handleMessage()
 */

import type { NormalizedMessage } from "../types/normalized-message.js";
import type { Agent } from "../types/agent.js";
import type { ChannelResponse } from "../types/channel-adapter.js";
import { parseIntent } from "./intent-parser.js";

export class MessageRouter {
  private agents: Map<string, Agent> = new Map();

  /** Register an agent for routing */
  registerAgent(projectId: string, agent: Agent): void {
    this.agents.set(projectId, agent);
  }

  /** Remove an agent */
  unregisterAgent(projectId: string): void {
    this.agents.delete(projectId);
  }

  /** Route a message to the appropriate agent */
  async route(message: NormalizedMessage): Promise<ChannelResponse | null> {
    // Only process messages that mention the bot or are DMs
    if (!message.isMentioningBot && !message.isDM) {
      return null;
    }

    const intent = parseIntent(message.text);

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
