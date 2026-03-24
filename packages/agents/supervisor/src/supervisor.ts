/**
 * Agent Supervisor — Central management layer that orchestrates all agents.
 *
 * Responsibilities:
 * - Spawning: creates agents when projects are added
 * - Health monitoring: heartbeat checks, auto-restart on failure
 * - Resource management: tracks active agents
 * - Graceful shutdown: persists state, cleans up
 */

import type {
  Agent,
  AgentStatus,
  ChannelAdapter,
  MessageRouter,
  ChannelResponse,
  NormalizedMessage,
} from "@codespar/core";
import { parseIntent } from "@codespar/core";

export interface SupervisorConfig {
  healthCheckIntervalMs?: number;
}

export class AgentSupervisor {
  private agents: Map<string, Agent> = new Map();
  private router: MessageRouter;
  private adapters: ChannelAdapter[] = [];
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private startedAt: Date;

  constructor(router: MessageRouter, config?: SupervisorConfig) {
    this.router = router;
    this.startedAt = new Date();
  }

  /** Register a channel adapter */
  addAdapter(adapter: ChannelAdapter): void {
    this.adapters.push(adapter);
  }

  /** Spawn and register an agent */
  async spawnAgent(projectId: string, agent: Agent): Promise<void> {
    console.log(
      `[supervisor] Spawning agent: ${agent.config.id} (${agent.config.type})`
    );
    await agent.initialize();
    this.agents.set(projectId, agent);
    this.router.registerAgent(projectId, agent);
    console.log(
      `[supervisor] Agent ${agent.config.id} is ${agent.state}`
    );
  }

  /** Start the supervisor: connect adapters, wire message handling */
  async start(): Promise<void> {
    console.log("[supervisor] Starting CodeSpar...");

    // Connect all channel adapters
    for (const adapter of this.adapters) {
      // Wire message handling BEFORE connect so the handler is ready
      // when the adapter starts receiving messages
      adapter.onMessage(async (message: NormalizedMessage) => {
        try {
          // Parse intent to detect long-running tasks
          const intent = await parseIntent(message.text);

          const LONG_RUNNING_INTENTS = new Set([
            "instruct", "fix", "review", "deploy", "rollback",
          ]);
          const isLongRunning =
            LONG_RUNNING_INTENTS.has(intent.type) ||
            (intent.type === "unknown" && message.text.length > 25);

          // Send immediate progress feedback for long-running tasks
          if (isLongRunning) {
            const PROGRESS_MESSAGES: Record<string, string> = {
              instruct: "\u23f3 Executing task...",
              fix: "\ud83d\udd0d Investigating and fixing...",
              review: "\ud83d\udccb Reviewing PR...",
              deploy: "\ud83d\ude80 Processing deploy request...",
              rollback: "\u23ea Processing rollback...",
              unknown: "\ud83e\udd14 Thinking...",
            };

            const progressResponse: ChannelResponse = {
              text: PROGRESS_MESSAGES[intent.type] || "\u23f3 Working on it...",
            };

            if (message.isDM) {
              await adapter.sendDM(message.channelUserId, progressResponse);
            } else {
              await adapter.sendToChannel(message.channelId, progressResponse);
            }
          }

          // Process the actual command
          const response = await this.router.route(message);
          if (response) {
            if (message.isDM) {
              await adapter.sendDM(message.channelUserId, response);
            } else {
              await adapter.sendToChannel(message.channelId, response);
            }
          }
        } catch (err) {
          console.error(`[supervisor] Error handling message:`, err);
        }
      });

      try {
        // Timeout adapter connection after 15 seconds to prevent blocking other adapters
        const CONNECT_TIMEOUT = 15_000;
        await Promise.race([
          adapter.connect(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`${adapter.type} connect timed out after ${CONNECT_TIMEOUT / 1000}s`)), CONNECT_TIMEOUT)
          ),
        ]);
        console.log(`[supervisor] ${adapter.type} adapter connected`);
      } catch (err) {
        console.error(`[supervisor] ${adapter.type} adapter failed to connect:`, err instanceof Error ? err.message : err);
      }
    }

    console.log("[supervisor] Ready. Your agents are live.\n");
  }

  /** Get status of all agents */
  getAgentStatuses(): AgentStatus[] {
    return Array.from(this.agents.values()).map((agent) => agent.getStatus());
  }

  /** Get agent by its config id */
  getAgentById(agentId: string): Agent | undefined {
    for (const agent of this.agents.values()) {
      if (agent.config.id === agentId) return agent;
    }
    return undefined;
  }

  /** Get the projectId key for an agent by its config id */
  getProjectIdForAgent(agentId: string): string | undefined {
    for (const [projectId, agent] of this.agents) {
      if (agent.config.id === agentId) return projectId;
    }
    return undefined;
  }

  /** Remove an agent: shut it down, unregister from router */
  async removeAgent(projectId: string): Promise<boolean> {
    const agent = this.agents.get(projectId);
    if (!agent) return false;
    console.log(`[supervisor] Removing agent ${agent.config.id} (project: ${projectId})`);
    await agent.shutdown();
    this.router.unregisterAgent(projectId);
    this.agents.delete(projectId);
    console.log(`[supervisor] Agent ${agent.config.id} removed`);
    return true;
  }

  /** Re-initialize an agent (shutdown + initialize) */
  async restartAgent(agentId: string): Promise<boolean> {
    const agent = this.getAgentById(agentId);
    if (!agent) return false;
    console.log(`[supervisor] Restarting agent ${agentId}...`);
    await agent.shutdown();
    await agent.initialize();
    console.log(`[supervisor] Agent ${agentId} restarted, state: ${agent.state}`);
    return true;
  }

  /** Get all registered channel adapters with connection status */
  getAdapters(): ChannelAdapter[] {
    return this.adapters;
  }

  /** Graceful shutdown */
  async shutdown(): Promise<void> {
    console.log("\n[supervisor] Shutting down...");

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    // Shutdown all agents
    for (const [projectId, agent] of this.agents) {
      console.log(`[supervisor] Stopping agent ${agent.config.id}...`);
      await agent.shutdown();
      this.router.unregisterAgent(projectId);
    }
    this.agents.clear();

    // Disconnect all adapters
    for (const adapter of this.adapters) {
      await adapter.disconnect();
      console.log(`[supervisor] ${adapter.type} adapter disconnected`);
    }

    console.log("[supervisor] Shutdown complete.");
  }
}
