# Contributing to CodeSpar

Welcome. CodeSpar is open source (MIT) and contributions are encouraged. This guide covers setup, conventions, and the PR process.

## Development Setup

```bash
git clone https://github.com/codespar/codespar.git
cd codespar
npm install
npm run build
npm start          # starts CLI mode (no Docker needed)
```

The CLI works without API keys. The Claude Code bridge falls back to simulation mode when `ANTHROPIC_API_KEY` is not set. Copy `.env.example` to `.env` and add your key for real execution.

## Running Tests

```bash
npx vitest run
```

All tests must pass before submitting a PR.

## Project Structure

```
codespar/
  package.json             # Root workspace (Turborepo)
  turbo.json               # Build pipeline
  tsconfig.base.json       # Shared TS config
  vitest.config.ts         # Test config
  server/                  # Fastify HTTP server, entry point
  packages/
    core/                  # Types, storage, auth, approval, webhooks, observability
    agents/                # Agent implementations
      project/             # Persistent, monitors repo + CI/CD
      task/                # Ephemeral, executes coding tasks
      review/              # Ephemeral, PR analysis + risk classification
      deploy/              # Ephemeral, deploy orchestration + approvals
      incident/            # Ephemeral, CI failure investigation
      coordinator/         # Persistent, cross-project orchestration
    channels/
      cli/                 # Terminal adapter (dev/debug)
      slack/               # Slack (Socket Mode)
      whatsapp/            # WhatsApp (Evolution API)
      telegram/            # Telegram (BotFather)
      discord/             # Discord (Gateway)
  apps/
    docs/                  # Documentation site (Fumadocs MDX)
```

Each package builds independently. `core` is a dependency of `agents` and `channels`.

## Writing a Custom Agent

Implement the `Agent` interface from `packages/core/src/types/agent.ts`, then register it with `registerAgentType`.

```typescript
// my-metrics-agent.ts
import type { Agent, AgentConfig, AgentStatus, AgentState } from "@codespar/core";
import type { NormalizedMessage } from "@codespar/core";
import type { ParsedIntent } from "@codespar/core";
import type { ChannelResponse } from "@codespar/core";
import { registerAgentType } from "@codespar/core";

class MetricsAgent implements Agent {
  readonly config: AgentConfig;
  state: AgentState = "IDLE";

  constructor(config: AgentConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    this.state = "ACTIVE";
  }

  async handleMessage(
    message: NormalizedMessage,
    intent: ParsedIntent,
  ): Promise<ChannelResponse> {
    return { text: `Metrics for ${this.config.projectId}: all green.` };
  }

  getStatus(): AgentStatus {
    return {
      id: this.config.id,
      type: this.config.type,
      state: this.state,
      autonomyLevel: this.config.autonomyLevel,
      uptimeMs: 0,
      tasksHandled: 0,
    };
  }

  async shutdown(): Promise<void> {
    this.state = "TERMINATED";
  }
}

// Register so the supervisor can instantiate it
registerAgentType("metrics", (config) => new MetricsAgent(config));
```

Key points:
- **Ephemeral agents** are spawned per-task and destroyed after completion.
- **Persistent agents** run continuously and maintain state.
- Agents receive a `NormalizedMessage` and never interact with channels directly.

## Writing a Channel Adapter

Implement the `ChannelAdapter` interface from `packages/core/src/types/channel-adapter.ts`.

```typescript
import type { ChannelAdapter, ChannelResponse, MessageHandler } from "@codespar/core";

class MyAdapter implements ChannelAdapter {
  readonly type = "my-platform";

  async connect(): Promise<void> {
    // Initialize SDK, open websocket, etc.
  }

  onMessage(handler: MessageHandler): void {
    // Wire platform events to the handler
  }

  async sendToChannel(channelId: string, response: ChannelResponse): Promise<void> {
    // Send response back to the platform
  }

  async disconnect(): Promise<void> {
    // Clean up connections
  }
}
```

The adapter is the only code that touches platform-specific APIs. Agents never know which channel a message came from.

## Code Style

- TypeScript strict mode, no `any` unless unavoidable
- kebab-case file names (`my-agent.ts`)
- PascalCase for classes and components (`MyAgent`)
- No em dashes in copy, use commas or semicolons instead
- Explicit over clever: if it is hard to follow, simplify it
- Handle edge cases: thoughtfulness over speed

## PR Process

1. Create a branch from `main`: `feature/<name>` or `fix/<name>`
2. Write tests for new behavior
3. Run `npm run build && npx vitest run` and confirm everything passes
4. Open a PR with a clear description of what changed and why
5. Keep diffs small and focused: one concern per PR

PRs are reviewed within 48 hours. Changes to agent or channel behavior must include documentation updates.

## Commit Messages

- Use imperative mood: "Add metrics agent" not "Added metrics agent"
- Explain why, not just what: "Add rate limiting to prevent webhook abuse" not "Add rate limiting"
- For AI-assisted commits, include: `Co-Authored-By: <tool> <email>`

## What NOT to Do

- Do not push directly to `main`
- Do not skip tests or merge with failing CI
- Do not add dependencies without justification (evaluate bundle impact)
- Do not store secrets in code; use environment variables
- Do not submit PRs without a description

## Issues

- **Bug reports:** Include reproduction steps, expected vs actual behavior, and environment details.
- **Feature requests:** Describe the use case, not just the solution. Explain what problem it solves.
- **RFCs:** For significant changes (new agent types, security model changes), open a GitHub Discussion first.

## Getting Help

- [Issues](https://github.com/codespar/codespar/issues)
- [Discussions](https://github.com/codespar/codespar/discussions)
- [Security](SECURITY.md) for vulnerability reporting
