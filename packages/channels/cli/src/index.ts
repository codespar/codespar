#!/usr/bin/env node

/**
 * CodeSpar CLI — Entry point.
 *
 * Starts the Agent Supervisor with a CLI adapter and a Project Agent.
 * Use this for development, debugging, and testing agent logic
 * without network dependencies.
 *
 * Usage:
 *   npx codespar
 *   # or after build:
 *   node packages/channels/cli/dist/index.js
 */

import { MessageRouter, FileStorage, ApprovalManager } from "@codespar/core";
import { AgentSupervisor } from "@codespar/agent-supervisor";
import { ProjectAgent } from "@codespar/agent-project";
import { CLIAdapter } from "./adapter.js";

async function main() {
  console.log("");
  console.log(
    "  code\x1b[34m<\x1b[0mspar\x1b[34m>\x1b[0m  v0.1.0"
  );
  console.log("  ─────────────────────────────");
  console.log("");

  // 1. Create the message router
  const router = new MessageRouter();

  // 2. Create the supervisor
  const supervisor = new AgentSupervisor(router);

  // 3. Create and register the CLI adapter
  const cli = new CLIAdapter();
  supervisor.addAdapter(cli);

  // 4. Create file-based storage for agent memory and audit
  const storage = new FileStorage();

  // 4b. Create shared ApprovalManager for deploy/rollback workflows
  const approvalManager = new ApprovalManager();

  // 5. Spawn a Project Agent (L1 Notify) with storage and approval manager
  const agent = new ProjectAgent({
    id: "agent-local",
    type: "project",
    projectId: "local-dev",
    autonomyLevel: 1,
  }, storage, approvalManager);
  await supervisor.spawnAgent("local-dev", agent);

  // 5. Start the supervisor (connects adapters, wires routing)
  await supervisor.start();

  // 6. Start the CLI REPL
  console.log('  Type "help" for commands, "exit" to quit.\n');
  await cli.startREPL();

  // Handle graceful shutdown
  const shutdown = async () => {
    await supervisor.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[codespar] Fatal error:", err);
  process.exit(1);
});
