/**
 * Queue factory — auto-detects REDIS_URL and returns the appropriate
 * implementation (Redis-backed or in-memory fallback).
 */

export { getRedisClient, closeRedis } from "./redis-client.js";
export {
  type EventBus,
  type EventBusChannel,
  type EventBusMessage,
  type EventBusHandler,
  RedisEventBus,
  InMemoryEventBus,
} from "./event-bus.js";
export {
  type TaskQueue,
  type QueuedTask,
  RedisTaskQueue,
  InMemoryTaskQueue,
} from "./task-queue.js";

import { getRedisClient } from "./redis-client.js";
import { RedisEventBus, InMemoryEventBus, type EventBus } from "./event-bus.js";
import { RedisTaskQueue, InMemoryTaskQueue, type TaskQueue } from "./task-queue.js";
import Redis from "ioredis";

/**
 * Create an EventBus instance.
 *
 * When REDIS_URL is set the bus uses Redis Pub/Sub (two connections:
 * the shared publisher and a dedicated subscriber).
 * Otherwise it returns an in-memory EventEmitter-based bus.
 */
export function createEventBus(): EventBus {
  const pub = getRedisClient();
  if (!pub) return new InMemoryEventBus();

  // Redis Pub/Sub requires a dedicated connection for subscribing.
  const url = process.env.REDIS_URL!;
  const sub = new Redis(url, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 200, 5000),
    lazyConnect: true,
  });

  return new RedisEventBus(pub, sub);
}

/**
 * Create a TaskQueue for a given project.
 *
 * When REDIS_URL is set the queue uses Redis Streams with consumer groups.
 * Otherwise it returns an in-memory FIFO queue.
 */
export function createTaskQueue(projectId: string): TaskQueue {
  const redis = getRedisClient();
  if (!redis) return new InMemoryTaskQueue();
  return new RedisTaskQueue(redis, projectId);
}
