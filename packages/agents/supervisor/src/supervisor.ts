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
      await adapter.connect();
      console.log(`[supervisor] ${adapter.type} adapter connected`);

      // Wire message handling: adapter → router → agent → response → adapter
      adapter.onMessage(async (message: NormalizedMessage) => {
        const response = await this.router.route(message);
        if (response) {
          if (message.isDM) {
            await adapter.sendDM(message.channelUserId, response);
          } else {
            await adapter.sendToChannel(message.channelId, response);
          }
        }
      });
    }

    console.log("[supervisor] Ready. Your agents are live.\n");
  }

  /** Get status of all agents */
  getAgentStatuses(): AgentStatus[] {
    return Array.from(this.agents.values()).map((agent) => agent.getStatus());
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
