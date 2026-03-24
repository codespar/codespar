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

import { MessageRouter, WebhookServer, FileStorage, ApprovalManager, VectorStore, IdentityStore, analyzeDeployFailure, formatSmartAlert, parseIntent } from "@codespar/core";
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
const vectorStore = new VectorStore();
const supervisor = new AgentSupervisor(router);

// 1b. Identity store — persistent cross-channel user resolution
const identityStore = new IdentityStore(storage);
await identityStore.load();

// Register the admin user (from env or default)
await identityStore.registerUser({
  displayName: process.env.ADMIN_NAME || "Admin",
  role: "owner",
  channelType: "cli",
  channelUserId: "local-user",
});

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
    supervisor.addAdapter(new SlackAdapter(storage));
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
  { id: agentId, type: "project", projectId, autonomyLevel: 1, orgId: "default" },
  storage,
  approvalManager,
  vectorStore
);
agent.setIdentityStore(identityStore);
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

// 5. Restore saved projects from default storage
const savedProjects = await storage.getProjectsList();
for (const proj of savedProjects) {
  if (proj.agentId === agentId) continue; // skip default
  try {
    const restoredAgent = new ProjectAgent(
      { id: proj.agentId, type: "project", projectId: proj.id, autonomyLevel: 1 },
      storage,
      approvalManager,
      vectorStore
    );
    restoredAgent.setIdentityStore(identityStore);
    await supervisor.spawnAgent(proj.id, restoredAgent);
    coordinator.registerProject(proj.id, proj.id, proj.agentId);
    coordinator.setProjectAgent(proj.id, restoredAgent);
    console.log(`[server] Restored project: ${proj.repo} → ${proj.agentId}`);
  } catch (err) {
    console.error(`[server] Failed to restore ${proj.repo}:`, err.message);
  }
}

// 5b. Restore saved projects from all org storages
import * as fs from "node:fs";
import * as path from "node:path";
const orgsDir = path.join(".codespar", "orgs");
try {
  if (fs.existsSync(orgsDir)) {
    const orgDirs = fs.readdirSync(orgsDir);
    for (const orgId of orgDirs) {
      try {
        const orgStorage = new FileStorage(".codespar", orgId);
        const orgProjects = await orgStorage.getProjectsList();
        for (const proj of orgProjects) {
          if (proj.agentId === agentId) continue;
          // Skip if already spawned
          if (supervisor.getAgentById(proj.agentId)) continue;
          try {
            const restoredAgent = new ProjectAgent(
              { id: proj.agentId, type: "project", projectId: proj.id, autonomyLevel: 1, orgId: orgId },
              orgStorage,
              approvalManager,
              vectorStore
            );
            restoredAgent.setIdentityStore(identityStore);
            await supervisor.spawnAgent(proj.id, restoredAgent);
            coordinator.registerProject(proj.id, proj.id, proj.agentId);
            coordinator.setProjectAgent(proj.id, restoredAgent);
            console.log(`[server] Restored org project: ${proj.repo} → ${proj.agentId} (org: ${orgId})`);
          } catch (err) {
            console.error(`[server] Failed to restore org project ${proj.repo}:`, err.message);
          }
        }
      } catch {
        // Skip orgs with no projects
      }
    }
  }
} catch (err) {
  console.error(`[server] Failed to scan org storages:`, err.message);
}

// 6. Start supervisor
await supervisor.start();

// 6b. Restore persisted agent states (suspend/resume and autonomy survive restart)
try {
  const savedStates = await storage.getAllAgentStates();
  for (const savedState of savedStates) {
    const restoredAgent = supervisor.getAgentById(savedState.agentId);
    if (!restoredAgent) continue;

    if (savedState.state === "suspended") {
      // Record suspended state so the agent skips processing on next tick
      console.log(`[server] Restoring suspended state for ${savedState.agentId}`);
      await storage.setMemory(savedState.agentId, "suspendedState", "SUSPENDED");
    }

    if (savedState.autonomyLevel !== undefined && savedState.autonomyLevel !== 1) {
      console.log(`[server] Restoring autonomy L${savedState.autonomyLevel} for ${savedState.agentId}`);
      restoredAgent.config.autonomyLevel = savedState.autonomyLevel;
    }
  }
} catch (err) {
  console.error("[server] Failed to restore agent states:", err.message);
}

// 7. Start webhook server
const webhookServer = new WebhookServer({ port });

webhookServer.onCIEvent(async (event) => {
  const response = agent.handleCIEvent(event);
  console.log(`[server] CI event: ${event.type} \u2014 ${event.status}`);
});

webhookServer.setAgentCount(supervisor.getAgentStatuses().length);
webhookServer.setAgentSupervisor(supervisor);
webhookServer.setStorageProvider(storage);
webhookServer.setApprovalManager(approvalManager);
webhookServer.setIdentityStore(identityStore);
webhookServer.setVectorStore(vectorStore);

// Wire web chat messages through the same message router as channel adapters
webhookServer.setChatHandler(async (message, orgId) => {
  return router.route(message, orgId);
});

// Wire deploy alert handler -- analyzes failures with Claude, broadcasts to channels,
// and triggers autonomous healing based on agent autonomy level.
webhookServer.setAlertHandler(async (alert) => {
  console.log(`[alert] ${alert.type}: ${alert.project} (${alert.branch})`);

  if (alert.type === "deploy-failure") {
    // Smart analysis with Claude
    const analysis = await analyzeDeployFailure(alert);

    if (analysis) {
      const message = formatSmartAlert(analysis);
      // Broadcast to all channels
      await supervisor.broadcastToAllChannels({ text: message });
      console.log(`[alert] Smart alert sent: ${analysis.severity} severity, ${analysis.confidence} confidence`);

      // Save error pattern to vector store for future reference
      try {
        await vectorStore.add({
          agentId: "system",
          content: `Error: ${alert.errorMessage}\nRoot cause: ${analysis.rootCause}\nFix: ${analysis.suggestedFix}\nFiles: ${analysis.affectedFiles.join(", ")}`,
          category: "pattern",
          metadata: {
            severity: analysis.severity,
            project: alert.project,
            branch: alert.branch,
          },
        });
        console.log("[alert] Saved error pattern to vector store");
      } catch { /* ignore vector store errors */ }
    } else {
      // Fallback: send basic alert
      const basicMsg = `\u26a0\ufe0f Deploy failed: ${alert.project}\n  Branch: ${alert.branch}\n  Error: ${alert.errorMessage || "Unknown"}`;
      await supervisor.broadcastToAllChannels({ text: basicMsg });
    }

    // Phase 3: Autonomous healing based on agent autonomy level
    const agentStatuses = supervisor.getAgentStatuses();
    const projectAgent = agentStatuses.find(a => {
      const projectMatch = a.projectId === alert.project ||
        a.id.includes(alert.project) ||
        (alert.repo && a.id.includes(alert.repo.split("/")[1]));
      return projectMatch;
    });

    const autonomyLevel = projectAgent?.autonomyLevel ?? 1;

    if (autonomyLevel >= 3 && analysis) {
      // L3+: auto-investigate (the smart analysis already provides investigation)
      console.log(`[alert] L${autonomyLevel}: Auto-investigating ${alert.project}`);
    }

    if (autonomyLevel >= 4 && analysis && analysis.confidence !== "low") {
      // L4+: auto-create fix PR
      console.log(`[alert] L${autonomyLevel}: Auto-fixing ${alert.project}`);
      const fixAgent = [...router.getAgents().values()].find(a =>
        a.config.projectId === alert.project || a.config.id.includes(alert.project.split("/").pop())
      );
      if (fixAgent) {
        try {
          const fixMessage = {
            id: `auto-heal-${Date.now()}`,
            channelType: "system",
            channelId: "system",
            channelUserId: "system",
            isDM: false,
            isMentioningBot: true,
            text: `instruct Fix the deploy failure on ${alert.branch}. Error: ${alert.errorMessage}. Suggested fix: ${analysis.suggestedFix}`,
            timestamp: new Date(),
          };
          const fixIntent = await parseIntent(fixMessage.text);
          const fixResponse = await fixAgent.handleMessage(fixMessage, fixIntent);
          if (fixResponse) {
            await supervisor.broadcastToAllChannels({
              text: `\uD83D\uDD27 **Auto-fix initiated** for ${alert.project}\n\n${fixResponse.text}`,
            });
          }
        } catch (err) {
          console.error(`[alert] Auto-fix failed for ${alert.project}:`, err.message);
        }
      }
    }
  } else if (alert.type === "deploy-success") {
    const msg = `\u2705 Deploy succeeded: ${alert.project}\n  ${alert.commitMessage ? alert.commitMessage.slice(0, 80) : ""}${alert.url ? `\n  ${alert.url}` : ""}`;
    // Only broadcast success for production deploys (less noise)
    // await supervisor.broadcastToAllChannels({ text: msg });
    console.log(`[alert] Deploy success: ${alert.project}`);
  }
});

// Give webhook server ability to dynamically create agents
webhookServer.setAgentFactory({
  async createAgent(newProjectId, newAgentId, repo, orgId) {
    const newAgent = new ProjectAgent(
      { id: newAgentId, type: "project", projectId: newProjectId, autonomyLevel: 1, orgId: orgId || "default" },
      storage,
      approvalManager,
      vectorStore
    );
    newAgent.setIdentityStore(identityStore);
    await supervisor.spawnAgent(newProjectId, newAgent);
    // Register with coordinator for multi-project routing
    coordinator.registerProject(newProjectId, newProjectId, newAgentId);
    coordinator.setProjectAgent(newProjectId, newAgent);
    // Link repo config
    await storage.setProjectConfig(newAgentId, {
      repoUrl: `https://github.com/${repo}`,
      repoOwner: repo.split("/")[0],
      repoName: repo.split("/")[1],
      linkedAt: new Date().toISOString(),
      linkedBy: "dashboard",
      webhookConfigured: false,
    });
  }
});

await webhookServer.start();

console.log(`[server] Webhook server on port ${port}`);
console.log("[server] Ready.\n");

// 8. Graceful shutdown
const shutdown = async () => {
  console.log("\n[server] Shutting down...");
  await webhookServer.stop();
  await supervisor.shutdown();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
