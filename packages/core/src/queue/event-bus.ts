/**
 * Event bus abstraction over Redis Pub/Sub.
 *
 * Falls back to an in-memory EventEmitter when Redis is unavailable
 * so the system works in local dev without Docker dependencies.
 */

import { EventEmitter } from "node:events";
import type { Redis } from "ioredis";

// ── Types ───────────────────────────────────────────────────────────

export type EventBusChannel =
  | "agent:progress"
  | "agent:status"
  | "task:created"
  | "task:completed"
  | "deploy:status";

export interface EventBusMessage {
  type: string;
  agentId?: string;
  projectId?: string;
  timestamp: number;
  payload: unknown;
}

export type EventBusHandler = (message: EventBusMessage) => void;

// ── Interface ───────────────────────────────────────────────────────

export interface EventBus {
  publish(channel: EventBusChannel, event: EventBusMessage): Promise<void>;
  subscribe(channel: EventBusChannel, handler: EventBusHandler): Promise<void>;
  unsubscribe(channel: EventBusChannel): Promise<void>;
  close(): Promise<void>;
}

// ── Redis implementation ────────────────────────────────────────────

export class RedisEventBus implements EventBus {
  /** Publisher connection (shared with other uses). */
  private readonly pub: Redis;
  /** Dedicated subscriber connection (Redis requirement). */
  private readonly sub: Redis;
  private readonly handlers = new Map<EventBusChannel, EventBusHandler>();

  constructor(pub: Redis, sub: Redis) {
    this.pub = pub;
    this.sub = sub;

    this.sub.on("message", (channel: string, raw: string) => {
      const handler = this.handlers.get(channel as EventBusChannel);
      if (!handler) return;
      try {
        const message = JSON.parse(raw) as EventBusMessage;
        handler(message);
      } catch {
        // Malformed message — skip silently (could log with Pino later).
      }
    });
  }

  async publish(channel: EventBusChannel, event: EventBusMessage): Promise<void> {
    await this.pub.publish(channel, JSON.stringify(event));
  }

  async subscribe(channel: EventBusChannel, handler: EventBusHandler): Promise<void> {
    this.handlers.set(channel, handler);
    await this.sub.subscribe(channel);
  }

  async unsubscribe(channel: EventBusChannel): Promise<void> {
    this.handlers.delete(channel);
    await this.sub.unsubscribe(channel);
  }

  async close(): Promise<void> {
    for (const channel of this.handlers.keys()) {
      await this.sub.unsubscribe(channel);
    }
    this.handlers.clear();
    await this.sub.quit();
    // Do not quit `pub` — it is the shared client managed by redis-client.ts.
  }
}

// ── In-memory fallback ──────────────────────────────────────────────

export class InMemoryEventBus implements EventBus {
  private readonly emitter = new EventEmitter();
  private readonly handlers = new Map<EventBusChannel, EventBusHandler>();

  async publish(channel: EventBusChannel, event: EventBusMessage): Promise<void> {
    this.emitter.emit(channel, event);
  }

  async subscribe(channel: EventBusChannel, handler: EventBusHandler): Promise<void> {
    this.handlers.set(channel, handler);
    this.emitter.on(channel, handler);
  }

  async unsubscribe(channel: EventBusChannel): Promise<void> {
    const handler = this.handlers.get(channel);
    if (handler) {
      this.emitter.removeListener(channel, handler);
      this.handlers.delete(channel);
    }
  }

  async close(): Promise<void> {
    this.emitter.removeAllListeners();
    this.handlers.clear();
  }
}
