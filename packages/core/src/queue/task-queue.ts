/**
 * Task queue abstraction over Redis Streams.
 *
 * Uses XADD / XREADGROUP / XACK for reliable, at-least-once delivery.
 * Falls back to a simple in-memory FIFO array when Redis is unavailable.
 */

import type Redis from "ioredis";

// ── Types ───────────────────────────────────────────────────────────

export interface QueuedTask {
  /** Stream entry ID (set after enqueue). */
  id?: string;
  type: string;
  agentId?: string;
  projectId: string;
  payload: unknown;
  createdAt: number;
}

export interface TaskQueue {
  enqueue(task: QueuedTask): Promise<string>;
  dequeue(consumer: string): Promise<QueuedTask | null>;
  acknowledge(taskId: string): Promise<void>;
  pending(): Promise<number>;
  close(): Promise<void>;
}

// ── Constants ───────────────────────────────────────────────────────

const CONSUMER_GROUP = "codespar:agents";
const BLOCK_MS = 2000;
const COUNT = 1;

function streamKey(projectId: string): string {
  return `codespar:tasks:${projectId}`;
}

// ── Redis Streams implementation ────────────────────────────────────

export class RedisTaskQueue implements TaskQueue {
  private readonly redis: Redis;
  private readonly key: string;
  private groupCreated = false;

  constructor(redis: Redis, projectId: string) {
    this.redis = redis;
    this.key = streamKey(projectId);
  }

  /** Ensure the consumer group exists (idempotent). */
  private async ensureGroup(): Promise<void> {
    if (this.groupCreated) return;
    try {
      await this.redis.xgroup("CREATE", this.key, CONSUMER_GROUP, "0", "MKSTREAM");
    } catch (err: unknown) {
      // "BUSYGROUP" means the group already exists — safe to ignore.
      if (err instanceof Error && !err.message.includes("BUSYGROUP")) {
        throw err;
      }
    }
    this.groupCreated = true;
  }

  async enqueue(task: QueuedTask): Promise<string> {
    await this.ensureGroup();
    const id = await this.redis.xadd(
      this.key,
      "*",
      "data",
      JSON.stringify(task),
    );
    return id;
  }

  async dequeue(consumer: string): Promise<QueuedTask | null> {
    await this.ensureGroup();
    const results = await this.redis.xreadgroup(
      "GROUP",
      CONSUMER_GROUP,
      consumer,
      "COUNT",
      COUNT,
      "BLOCK",
      BLOCK_MS,
      "STREAMS",
      this.key,
      ">",
    );
    if (!results || results.length === 0) return null;

    // results shape: [[streamKey, [[entryId, [field, value, ...]]]]]
    const entries = results[0][1] as Array<[string, string[]]>;
    if (!entries || entries.length === 0) return null;

    const [entryId, fields] = entries[0];
    // fields is a flat array: ["data", "{...}"]
    const dataIndex = fields.indexOf("data");
    if (dataIndex === -1 || dataIndex + 1 >= fields.length) return null;

    const task = JSON.parse(fields[dataIndex + 1]) as QueuedTask;
    task.id = entryId;
    return task;
  }

  async acknowledge(taskId: string): Promise<void> {
    await this.redis.xack(this.key, CONSUMER_GROUP, taskId);
  }

  async pending(): Promise<number> {
    await this.ensureGroup();
    const info = await this.redis.xpending(this.key, CONSUMER_GROUP);
    // xpending summary: [pendingCount, minId, maxId, [[consumer, count], ...]]
    if (!info || !Array.isArray(info)) return 0;
    return typeof info[0] === "number" ? info[0] : Number(info[0]) || 0;
  }

  async close(): Promise<void> {
    // The Redis client is shared — do not quit it here.
  }
}

// ── In-memory fallback ──────────────────────────────────────────────

export class InMemoryTaskQueue implements TaskQueue {
  private readonly queue: QueuedTask[] = [];
  private readonly inflight = new Map<string, QueuedTask>();
  private counter = 0;

  async enqueue(task: QueuedTask): Promise<string> {
    const id = `mem-${++this.counter}`;
    task.id = id;
    this.queue.push(task);
    return id;
  }

  async dequeue(_consumer: string): Promise<QueuedTask | null> {
    const task = this.queue.shift() ?? null;
    if (task && task.id) {
      this.inflight.set(task.id, task);
    }
    return task;
  }

  async acknowledge(taskId: string): Promise<void> {
    this.inflight.delete(taskId);
  }

  async pending(): Promise<number> {
    return this.inflight.size;
  }

  async close(): Promise<void> {
    this.queue.length = 0;
    this.inflight.clear();
  }
}
