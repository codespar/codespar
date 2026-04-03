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

import { MessageRouter, WebhookServer, FileStorage, createStorage, ApprovalManager, VectorStore, IdentityStore, analyzeDeployFailure, formatSmartAlert, parseIntent, broadcastEvent, DeployHealthMonitor, ChannelRouter } from "@codespar/core";
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
const storage = createStorage();
console.log(`[server] Storage: ${process.env.DATABASE_URL ? "PostgreSQL" : "FileStorage"}`);
const approvalManager = new ApprovalManager();
const vectorStore = new VectorStore();
const healthMonitor = new DeployHealthMonitor(storage);
const supervisor = new AgentSupervisor(router);

// 1c. Channel router — per-channel alert routing (e.g., #devops gets deploy alerts)
const channelRouter = new ChannelRouter();
try {
  await channelRouter.loadFromStorage(storage);
  const routeCount = channelRouter.list().length;
  if (routeCount > 0) {
    console.log(`[server] Loaded ${routeCount} channel route(s)`);
  }
} catch (err) {
  console.error("[server] Failed to load channel routes:", err.message);
}

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
        const orgStorage = createStorage(orgId);
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
  // Route CI event to the agent that owns the repo
  const repoName = event.repo?.split("/")[1] || "";
  const statuses = supervisor.getAgentStatuses();
  const match = statuses.find((a) =>
    a.projectId === repoName || a.id.includes(repoName)
  );

  if (match) {
    const targetAgent = supervisor.getAgentById(match.id);
    if (targetAgent && targetAgent.handleCIEvent) {
      targetAgent.handleCIEvent(event);
      console.log(`[server] CI event: ${event.type} \u2014 ${event.status} \u2192 ${match.id}`);
      return;
    }
  }

  // Fallback to default agent
  agent.handleCIEvent(event);
  console.log(`[server] CI event: ${event.type} \u2014 ${event.status} \u2192 agent-default (fallback)`);
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
      // Route to targeted channels (falls back to broadcast if no routes configured)
      await supervisor.broadcastToTargetedChannels({ text: message }, "deploy", alert.project, channelRouter);
      console.log(`[alert] Smart alert sent: ${analysis.severity} severity, ${analysis.confidence} confidence`);

      // Broadcast analyzed alert to dashboard via SSE + EventBus
      broadcastEvent({ type: "alert.analyzed", data: { ...analysis, project: alert.project, branch: alert.branch, orgId: alert.orgId } }, alert.orgId);
      try {
        const eventBus = webhookServer.getEventBus?.();
        if (eventBus) {
          eventBus.publish("alert:analyzed", { type: "alert:analyzed", projectId: alert.project, timestamp: Date.now(), payload: { ...analysis, project: alert.project, orgId: alert.orgId } }).catch(() => {});
        }
      } catch { /* ignore eventBus errors */ }

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
      await supervisor.broadcastToTargetedChannels({ text: basicMsg }, "deploy", alert.project, channelRouter);
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
            await supervisor.broadcastToTargetedChannels(
              { text: `\uD83D\uDD27 **Auto-fix initiated** for ${alert.project}\n\n${fixResponse.text}` },
              "deploy", alert.project, channelRouter,
            );
          }
        } catch (err) {
          console.error(`[alert] Auto-fix failed for ${alert.project}:`, err.message);
        }
      }
    }
  } else if (alert.type === "sentry-error") {
    // Sentry production errors — analyze and broadcast
    const analysis = await analyzeDeployFailure(alert);
    if (analysis) {
      const message = formatSmartAlert(analysis);
      await supervisor.broadcastToTargetedChannels({ text: message }, "error", alert.project, channelRouter);
      console.log(`[alert] Sentry alert sent: ${analysis.severity} severity`);

      broadcastEvent({ type: "sentry.analyzed", data: { ...analysis, project: alert.project, orgId: alert.orgId } }, alert.orgId);
      try {
        const eventBus = webhookServer.getEventBus?.();
        if (eventBus) {
          eventBus.publish("sentry:error", { type: "sentry:error", projectId: alert.project, timestamp: Date.now(), payload: { ...analysis, project: alert.project, orgId: alert.orgId } }).catch(() => {});
        }
      } catch { /* ignore */ }
    }
  } else if (alert.type === "deploy-success") {
    console.log(`[alert] Deploy success: ${alert.project} — starting health monitor`);

    // Determine autonomy level for the project agent
    const agentStatuses = supervisor.getAgentStatuses();
    const matchedAgent = agentStatuses.find(a =>
      a.projectId === alert.project || a.id.includes(alert.project)
    );
    const autonomyLevel = matchedAgent?.autonomyLevel ?? 1;

    // Start post-deploy health monitoring (non-blocking)
    healthMonitor.monitor(
      alert.project,
      alert.deploymentId || `deploy-${Date.now()}`,
      {
        checkIntervalMs: 30_000,
        monitorDurationMs: 300_000,
        errorThreshold: 0.10,
        minSamples: 5,
      },
      // onUnhealthy — fires when error rate exceeds threshold for 2 consecutive checks
      async (result) => {
        const pct = (result.errorRate * 100).toFixed(1);
        console.log(`[alert] Deploy unhealthy: ${alert.project} — ${pct}% error rate`);

        if (autonomyLevel >= 4) {
          // L4+: auto-rollback via Vercel API (redeploy previous deployment)
          const rollbackMsg = `\u26a0\ufe0f **Auto-rollback triggered** for ${alert.project}\n  Error rate: ${pct}% (threshold: 10%)\n  Checked ${result.checkCount} times over ${result.duration}\n  Errors: ${result.errorCount}/${result.totalRequests} requests\n  Rolling back to previous deployment...`;
          await supervisor.broadcastToTargetedChannels({ text: rollbackMsg }, "incident", alert.project, channelRouter);

          // Attempt Vercel rollback if token is available
          const vercelToken = process.env.VERCEL_TOKEN;
          if (vercelToken && alert.deploymentId) {
            try {
              const resp = await fetch(`https://api.vercel.com/v13/deployments`, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${vercelToken}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  name: alert.project,
                  deploymentId: alert.deploymentId,
                  target: "production",
                }),
              });
              if (resp.ok) {
                await supervisor.broadcastToTargetedChannels({ text: `\u2705 Rollback initiated for ${alert.project}. Vercel is redeploying the previous version.` }, "incident", alert.project, channelRouter);
              } else {
                const body = await resp.text();
                await supervisor.broadcastToTargetedChannels({ text: `\u274c Rollback API call failed for ${alert.project}: ${resp.status} ${body.slice(0, 200)}` }, "incident", alert.project, channelRouter);
              }
            } catch (err) {
              console.error(`[alert] Vercel rollback failed:`, err.message);
              await supervisor.broadcastToTargetedChannels({ text: `\u274c Vercel rollback failed for ${alert.project}: ${err.message}` }, "incident", alert.project, channelRouter);
            }
          }
        } else if (autonomyLevel >= 3) {
          // L3: notify + suggest rollback
          const msg = `\u26a0\ufe0f **Deploy may be unhealthy** — ${alert.project}\n  Error rate: ${pct}% (threshold: 10%)\n  Checked ${result.checkCount} times over ${result.duration}\n  Errors: ${result.errorCount}/${result.totalRequests} requests\n  Consider rolling back. Use: @codespar rollback production`;
          await supervisor.broadcastToTargetedChannels({ text: msg }, "incident", alert.project, channelRouter);
        } else {
          // L1-L2: notify only
          const msg = `\u26a0\ufe0f **Deploy may be unhealthy** — ${alert.project}\n  Error rate: ${pct}% (threshold: 10%)\n  Checked ${result.checkCount} times over ${result.duration}\n  Errors: ${result.errorCount}/${result.totalRequests} requests\n  Consider investigating.`;
          await supervisor.broadcastToTargetedChannels({ text: msg }, "incident", alert.project, channelRouter);
        }

        // Broadcast unhealthy event to SSE
        broadcastEvent({ type: "deploy.unhealthy", data: { project: alert.project, errorRate: result.errorRate, errorCount: result.errorCount, totalRequests: result.totalRequests, duration: result.duration, orgId: alert.orgId } }, alert.orgId);
      },
      // onComplete — fires when monitoring window ends with healthy status
      (result) => {
        console.log(`[alert] Deploy healthy: ${alert.project} — ${result.checkCount} checks over ${result.duration}`);
        broadcastEvent({ type: "deploy.healthy", data: { project: alert.project, checkCount: result.checkCount, duration: result.duration, orgId: alert.orgId } }, alert.orgId);
      },
    ).catch((err) => {
      console.error(`[alert] Health monitor error for ${alert.project}:`, err.message);
    });
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
