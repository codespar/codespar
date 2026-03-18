# Contributing to CodeSpar

Thanks for your interest in contributing to CodeSpar! This guide will help you get set up and productive quickly.

## Quick Start (Local Development)

1. Clone and install:

```bash
git clone https://github.com/codespar/codespar.git
cd codespar
npm install
npm run build
```

2. Run the CLI (no Docker needed):

```bash
npm start
```

3. Test commands:

```
codespar> help
codespar> status
codespar> instruct add error handling
codespar> deploy staging
codespar> exit
```

> **Note:** For full functionality (PostgreSQL, Redis, channel adapters), use Docker Compose. The CLI adapter works standalone for development and debugging.

## Project Structure

```
codespar/
  package.json             # Root workspace config (Turborepo)
  turbo.json               # Turborepo pipeline configuration
  tsconfig.base.json       # Shared TypeScript config
  packages/
    core/                  # Shared types, utilities, security, audit trail
    agents/                # Agent implementations (project, task, review, deploy, incident, coordinator)
    channels/
      cli/                 # CLI adapter (terminal interface for dev/debug)
      slack/               # Slack adapter (OAuth + Bot token)
      whatsapp/            # WhatsApp adapter (Baileys, linked device)
      telegram/            # Telegram adapter (BotFather token)
      discord/             # Discord adapter (Bot token + Gateway)
```

Each package is independently buildable and publishable. The `core` package is a dependency of both `agents` and `channels`.

## Writing a Custom Agent

All agents implement the `Agent` interface and are registered with the Supervisor.

### 1. Create the agent file

```typescript
// packages/agents/my-agent/src/index.ts
import { Agent, AgentContext, AgentResult } from '@codespar/core';

export class MyAgent implements Agent {
  readonly name = 'my-agent';
  readonly type = 'ephemeral'; // or 'persistent'

  async canHandle(intent: string): Promise<boolean> {
    return intent === 'my-command';
  }

  async execute(context: AgentContext): Promise<AgentResult> {
    // 1. Parse the incoming message
    const { message, project, user } = context;

    // 2. Do your work (call APIs, run tools, etc.)
    const result = await this.doWork(message);

    // 3. Return a structured result
    return {
      success: true,
      message: result.summary,
      artifacts: result.artifacts ?? [],
    };
  }

  private async doWork(message: string) {
    // Your agent logic here
    return { summary: 'Done!', artifacts: [] };
  }
}
```

### 2. Register with the Supervisor

```typescript
import { Supervisor } from '@codespar/core';
import { MyAgent } from '@codespar/agents/my-agent';

supervisor.register(new MyAgent());
```

### 3. Key concepts

- **Ephemeral agents** are spawned per-task and destroyed after completion (task, review, deploy, incident).
- **Persistent agents** run continuously and maintain state (project, coordinator).
- Every agent is scoped to a single project — no cross-project data access.
- Agents receive a `NormalizedMessage` and never interact with channels directly.

## Writing a Channel Adapter

Channel adapters normalize platform-specific messages into a unified format.

### 1. Implement the ChannelAdapter interface

```typescript
// packages/channels/my-channel/src/index.ts
import {
  ChannelAdapter,
  NormalizedMessage,
  OutboundMessage,
} from '@codespar/core';

export class MyChannelAdapter implements ChannelAdapter {
  readonly platform = 'my-channel';

  async connect(): Promise<void> {
    // Initialize your platform SDK/client
  }

  async disconnect(): Promise<void> {
    // Clean up connections
  }

  normalize(raw: unknown): NormalizedMessage {
    // Convert platform-specific message to NormalizedMessage
    return {
      id: raw.id,
      channelId: raw.channel,
      userId: raw.sender,
      text: raw.content,
      platform: this.platform,
      timestamp: new Date(raw.timestamp),
    };
  }

  async send(message: OutboundMessage): Promise<void> {
    // Send a message back to the platform
  }
}
```

### 2. Key principles

- The adapter is the **only** place that touches platform-specific APIs.
- Agents never know which channel a message came from.
- All messages flow through `NormalizedMessage` — same shape regardless of platform.
- Handle reconnection and rate limiting inside the adapter.

## Code Style

- **TypeScript strict mode** — no `any` unless absolutely necessary.
- **Biome** for formatting and linting (planned; currently manual).
- **Meaningful variable names** — clarity over brevity.
- **No abbreviations in public APIs** — `message` not `msg`, `configuration` not `cfg`.
- **Explicit over clever** — if it's hard to follow, simplify it.
- **Handle edge cases** — thoughtfulness over speed.

## PR Process

1. **Fork** the repository.
2. **Branch** from `main` — use `feature/<name>` or `fix/<name>`.
3. **Implement** your changes with tests.
4. **Test** — all existing tests must pass (`npm test`).
5. **Submit a PR** with a clear description of what and why.

### Expectations

- PRs are reviewed within **48 hours**.
- Changes to agent or channel behavior **must update documentation**.
- All tests must pass before merge.
- Keep diffs small and focused — one concern per PR.

## Architecture Decisions

For significant changes (new agent types, new channel adapters, security model changes, data model changes):

1. **Open an RFC** as a GitHub Discussion first.
2. Describe the problem, proposed solution, and alternatives considered.
3. Link the Discussion in your PR.

This keeps the conversation visible and gives the community a chance to weigh in before implementation work begins.

## Getting Help

- **Issues:** [github.com/codespar/codespar/issues](https://github.com/codespar/codespar/issues)
- **Discussions:** [github.com/codespar/codespar/discussions](https://github.com/codespar/codespar/discussions)
- **Security:** See [SECURITY.md](SECURITY.md) for vulnerability reporting.
