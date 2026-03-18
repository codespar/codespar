#!/usr/bin/env node

/**
 * CodeSpar Server — Production entry point.
 *
 * Starts the webhook server, connects enabled channel adapters,
 * and spawns the Project Agent.
 *
 * ENV:
 *   PORT              — HTTP port (default 3000)
 *   ENABLE_WHATSAPP   — "true" to enable WhatsApp
 *   ENABLE_SLACK      — "true" to enable Slack
 *   ENABLE_TELEGRAM   — "true" to enable Telegram
 *   ENABLE_DISCORD    — "true" to enable Discord
 *   PROJECT_NAME      — Project identifier (default "default")
 */

import { MessageRouter, WebhookServer, FileStorage, ApprovalManager } from "@codespar/core";
import { AgentSupervisor } from "@codespar/agent-supervisor";
import { ProjectAgent } from "@codespar/agent-project";
import { CoordinatorAgent } from "@codespar/agent-coordinator";

const port = parseInt(process.env.PORT || "3000", 10);
const projectId = process.env.PROJECT_NAME || "default";
const agentId = `agent-${projectId}`;

console.log("");
console.log("  code\x1b[34m<\x1b[0mspar\x1b[34m>\x1b[0m  v0.1.0 (server)");
console.log("  ─────────────────────────────");
console.log("");

// 1. Core services
const router = new MessageRouter();
const storage = new FileStorage();
const approvalManager = new ApprovalManager();
const supervisor = new AgentSupervisor(router);

// 2. Channel adapters (conditional)
if (process.env.ENABLE_WHATSAPP === "true") {
  try {
    const { WhatsAppAdapter } = await import("@codespar/channel-whatsapp");
    supervisor.addAdapter(new WhatsAppAdapter());
    console.log("[server] \u2713 WhatsApp adapter enabled");
  } catch (err) {
    console.error("[server] \u2717 WhatsApp adapter failed:", err.message);
  }
}

if (process.env.ENABLE_SLACK === "true") {
  try {
    const { SlackAdapter } = await import("@codespar/channel-slack");
    supervisor.addAdapter(new SlackAdapter());
    console.log("[server] \u2713 Slack adapter enabled");
  } catch (err) {
    console.error("[server] \u2717 Slack adapter failed:", err.message);
  }
}

if (process.env.ENABLE_TELEGRAM === "true") {
  try {
    const { TelegramAdapter } = await import("@codespar/channel-telegram");
    supervisor.addAdapter(new TelegramAdapter());
    console.log("[server] \u2713 Telegram adapter enabled");
  } catch (err) {
    console.error("[server] \u2717 Telegram adapter failed:", err.message);
  }
}

if (process.env.ENABLE_DISCORD === "true") {
  try {
    const { DiscordAdapter } = await import("@codespar/channel-discord");
    supervisor.addAdapter(new DiscordAdapter());
    console.log("[server] \u2713 Discord adapter enabled");
  } catch (err) {
    console.error("[server] \u2717 Discord adapter failed:", err.message);
  }
}

// 3. Spawn Project Agent (registered first so the router defaults to it)
const agent = new ProjectAgent(
  { id: agentId, type: "project", projectId, autonomyLevel: 1 },
  storage,
  approvalManager
);
await supervisor.spawnAgent(projectId, agent);

// 4. Spawn Coordinator Agent (per-org, cross-project orchestration)
const coordinator = new CoordinatorAgent({
  id: "coordinator",
  type: "coordinator",
  autonomyLevel: 0,
});
coordinator.registerProject("default", projectId, agentId);
coordinator.setProjectAgent("default", agent);
await supervisor.spawnAgent("_coordinator", coordinator);

// 5. Start supervisor
await supervisor.start();

// 6. Start webhook server
const webhookServer = new WebhookServer({ port });

webhookServer.onCIEvent(async (event) => {
  const response = agent.handleCIEvent(event);
  console.log(`[server] CI event: ${event.type} \u2014 ${event.status}`);
});

webhookServer.setAgentCount(2);
webhookServer.setAgentSupervisor(supervisor);
webhookServer.setStorageProvider(storage);
webhookServer.setApprovalManager(approvalManager);
await webhookServer.start();

console.log(`[server] Webhook server on port ${port}`);
console.log("[server] Ready.\n");

// 7. Graceful shutdown
const shutdown = async () => {
  console.log("\n[server] Shutting down...");
  await webhookServer.stop();
  await supervisor.shutdown();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
