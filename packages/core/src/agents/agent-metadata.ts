/**
 * A2A Agent Card metadata definitions for all CodeSpar agent types.
 *
 * Each entry follows Google's A2A (Agent-to-Agent) protocol pattern,
 * describing the agent's capabilities, lifecycle, and skills for
 * discovery and orchestration.
 */

import type { AgentMetadata } from "../types/agent.js";
import { registerAgentMetadata } from "./agent-registry.js";

const AGENT_METADATA: AgentMetadata[] = [
  {
    type: "project",
    displayName: "Project Agent",
    description:
      "Persistent agent that monitors a repository, CI/CD pipelines, and team channels. " +
      "Maintains codebase context and spawns ephemeral agents for tasks, reviews, and deploys.",
    lifecycle: "persistent",
    capabilities: {
      streaming: true,
      pushNotifications: true,
      autonomyLevels: ["L0", "L1", "L2", "L3", "L4", "L5"],
    },
    skills: [
      {
        id: "project.monitor-ci",
        name: "CI/CD Monitoring",
        description: "Watches build pipelines, detects failures, and reports status to team channels.",
        inputModes: ["webhook", "text"],
        outputModes: ["text", "structured"],
      },
      {
        id: "project.codebase-context",
        name: "Codebase Context",
        description: "Maintains a semantic graph of the repository structure, dependencies, and team knowledge.",
        inputModes: ["text"],
        outputModes: ["text", "structured"],
      },
      {
        id: "project.agent-orchestration",
        name: "Agent Orchestration",
        description: "Spawns and coordinates ephemeral agents (task, review, deploy, incident) based on events.",
        inputModes: ["text", "webhook"],
        outputModes: ["text"],
      },
    ],
    requiredServices: ["github", "redis", "storage"],
  },
  {
    type: "task",
    displayName: "Task Agent",
    description:
      "Ephemeral agent that executes coding tasks in isolated Docker containers using Claude Code. " +
      "Creates branches, writes code, runs tests, and opens pull requests.",
    lifecycle: "ephemeral",
    capabilities: {
      streaming: true,
      pushNotifications: false,
      autonomyLevels: ["L0", "L1", "L2", "L3"],
    },
    skills: [
      {
        id: "task.code-execution",
        name: "Code Execution",
        description: "Executes coding instructions in a sandboxed Docker container with Claude Code.",
        inputModes: ["text"],
        outputModes: ["text", "diff", "structured"],
      },
      {
        id: "task.create-pr",
        name: "Pull Request Creation",
        description: "Commits changes, pushes branches, and opens pull requests with descriptive summaries.",
        inputModes: ["text"],
        outputModes: ["text", "structured"],
      },
      {
        id: "task.test-runner",
        name: "Test Runner",
        description: "Runs the project test suite and reports results with failure analysis.",
        inputModes: ["text"],
        outputModes: ["text", "structured"],
      },
    ],
    requiredServices: ["docker", "github", "claude-code"],
  },
  {
    type: "review",
    displayName: "Review Agent",
    description:
      "Ephemeral agent that analyzes pull requests for code quality, security, and correctness. " +
      "Auto-approves low-risk changes per policy, escalates high-risk for human review.",
    lifecycle: "ephemeral",
    capabilities: {
      streaming: true,
      pushNotifications: false,
      autonomyLevels: ["L0", "L1", "L2", "L3", "L4"],
    },
    skills: [
      {
        id: "review.pr-analysis",
        name: "PR Analysis",
        description: "Reviews pull request diffs for bugs, security issues, and style violations.",
        inputModes: ["text", "webhook"],
        outputModes: ["text", "structured"],
      },
      {
        id: "review.auto-approve",
        name: "Auto-Approval",
        description: "Automatically approves low-risk changes (formatting, docs, dependency bumps) per policy.",
        inputModes: ["webhook"],
        outputModes: ["text"],
      },
      {
        id: "review.security-scan",
        name: "Security Scan",
        description: "Detects leaked secrets, vulnerable dependencies, and insecure patterns in code changes.",
        inputModes: ["text", "webhook"],
        outputModes: ["text", "structured"],
      },
    ],
    requiredServices: ["github", "claude-code"],
  },
  {
    type: "deploy",
    displayName: "Deploy Agent",
    description:
      "Ephemeral agent that orchestrates deployments with pre-checks, approval collection, " +
      "health monitoring, and automatic rollback on failure.",
    lifecycle: "ephemeral",
    capabilities: {
      streaming: true,
      pushNotifications: true,
      autonomyLevels: ["L0", "L1", "L2"],
    },
    skills: [
      {
        id: "deploy.orchestrate",
        name: "Deploy Orchestration",
        description: "Runs pre-deploy checks, collects approvals, triggers deployment, and monitors health.",
        inputModes: ["text"],
        outputModes: ["text", "structured"],
      },
      {
        id: "deploy.health-monitor",
        name: "Health Monitoring",
        description: "Monitors post-deploy health metrics, error rates, and latency for anomalies.",
        inputModes: ["webhook"],
        outputModes: ["text", "structured"],
      },
      {
        id: "deploy.rollback",
        name: "Automatic Rollback",
        description: "Reverts to the previous deployment version when health checks fail or errors spike.",
        inputModes: ["text", "webhook"],
        outputModes: ["text"],
      },
    ],
    requiredServices: ["github", "redis", "storage"],
  },
  {
    type: "incident",
    displayName: "Incident Agent",
    description:
      "Ephemeral agent that investigates production errors by correlating with recent changes, " +
      "analyzing logs, and proposing hotfixes or rollback recommendations.",
    lifecycle: "ephemeral",
    capabilities: {
      streaming: true,
      pushNotifications: true,
      autonomyLevels: ["L0", "L1", "L2"],
    },
    skills: [
      {
        id: "incident.investigate",
        name: "Error Investigation",
        description: "Analyzes production errors, stack traces, and logs to identify root cause.",
        inputModes: ["text", "webhook"],
        outputModes: ["text", "structured"],
      },
      {
        id: "incident.correlate-changes",
        name: "Change Correlation",
        description: "Correlates production incidents with recent deployments, PRs, and config changes.",
        inputModes: ["text"],
        outputModes: ["text", "structured"],
      },
      {
        id: "incident.hotfix-proposal",
        name: "Hotfix Proposal",
        description: "Proposes targeted fixes or rollback strategies based on incident analysis.",
        inputModes: ["text"],
        outputModes: ["text", "diff"],
      },
    ],
    requiredServices: ["github", "sentry", "claude-code"],
  },
  {
    type: "coordinator",
    displayName: "Coordinator Agent",
    description:
      "Persistent agent that handles cross-project orchestration, cascading deploys, " +
      "shared resource locks, and organization-wide coordination.",
    lifecycle: "persistent",
    capabilities: {
      streaming: true,
      pushNotifications: true,
      autonomyLevels: ["L0", "L1", "L2", "L3"],
    },
    skills: [
      {
        id: "coordinator.cross-project",
        name: "Cross-Project Orchestration",
        description: "Coordinates actions across multiple projects, such as cascading dependency updates.",
        inputModes: ["text"],
        outputModes: ["text", "structured"],
      },
      {
        id: "coordinator.resource-lock",
        name: "Resource Locking",
        description: "Manages shared resource locks to prevent conflicting deploys or migrations.",
        inputModes: ["text"],
        outputModes: ["text"],
      },
    ],
    requiredServices: ["redis", "storage"],
  },
  {
    type: "planning",
    displayName: "Planning Agent",
    description:
      "Ephemeral agent that breaks down features into sprint tasks, generates EARS-format specs, " +
      "and estimates effort based on codebase complexity.",
    lifecycle: "ephemeral",
    capabilities: {
      streaming: true,
      pushNotifications: false,
      autonomyLevels: ["L0", "L1", "L2"],
    },
    skills: [
      {
        id: "planning.sprint-breakdown",
        name: "Sprint Breakdown",
        description: "Decomposes a feature request into implementable tasks with dependencies and estimates.",
        inputModes: ["text"],
        outputModes: ["text", "structured"],
      },
      {
        id: "planning.spec-generation",
        name: "EARS Spec Generation",
        description: "Generates requirements in EARS (Easy Approach to Requirements Syntax) format.",
        inputModes: ["text"],
        outputModes: ["text", "structured"],
      },
      {
        id: "planning.effort-estimation",
        name: "Effort Estimation",
        description: "Estimates implementation effort based on codebase analysis and task complexity.",
        inputModes: ["text"],
        outputModes: ["text", "structured"],
      },
    ],
    requiredServices: ["claude-code", "storage"],
  },
  {
    type: "lens",
    displayName: "Lens Agent",
    description:
      "Ephemeral agent that scans codebases for architecture patterns, performance bottlenecks, " +
      "tech debt, and provides actionable improvement recommendations.",
    lifecycle: "ephemeral",
    capabilities: {
      streaming: true,
      pushNotifications: false,
      autonomyLevels: ["L0", "L1"],
    },
    skills: [
      {
        id: "lens.codebase-scan",
        name: "Codebase Scanning",
        description: "Analyzes repository structure, dependency graph, and architecture patterns.",
        inputModes: ["text"],
        outputModes: ["text", "structured"],
      },
      {
        id: "lens.performance-analysis",
        name: "Performance Analysis",
        description: "Identifies performance bottlenecks, N+1 queries, and resource-intensive code paths.",
        inputModes: ["text"],
        outputModes: ["text", "structured"],
      },
      {
        id: "lens.tech-debt-report",
        name: "Tech Debt Report",
        description: "Generates a prioritized report of technical debt with remediation recommendations.",
        inputModes: ["text"],
        outputModes: ["text", "structured"],
      },
    ],
    requiredServices: ["claude-code", "github"],
  },
];

/**
 * Register all built-in agent metadata entries.
 * Call this once during server startup.
 */
export function registerAllAgentMetadata(): void {
  for (const metadata of AGENT_METADATA) {
    registerAgentMetadata(metadata.type, metadata);
  }
}

export { AGENT_METADATA };
