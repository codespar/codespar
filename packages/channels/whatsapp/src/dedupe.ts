/**
 * Inbound webhook idempotency (F10.M4 / #366).
 *
 * Evolution API may redeliver `messages.upsert` events — on retry, on
 * reconnect, or because the runtime crashed between handler ack and
 * response. The bridge dedupes by `(channelType, eventId)` so the agent
 * is only invoked once per logical message.
 *
 * Two backends:
 *
 *   1. In-memory LRU (default). Bounded by `MAX_ENTRIES`; older keys
 *      eviction-prune as new ones arrive. Survives the lifetime of the
 *      runtime process; intentional, since channel webhooks are
 *      per-process.
 *
 *   2. Redis (optional escalation). When `REDIS_URL` is set the dedupe
 *      check uses `SET key value NX EX ttl` so multi-process / multi-pod
 *      deployments converge. Redis unavailability is a soft failure —
 *      we log a one-time warning and fall back to the in-memory LRU so a
 *      transient outage doesn't drop traffic.
 *
 * The dedupe key is `${channelType}:${eventId}`. `eventId` is whatever
 * the channel adapter sources — for WhatsApp it's `data.key.id`.
 */

const MAX_ENTRIES = 10_000;
const REDIS_TTL_SECONDS = 60 * 60 * 24; // 24 hours

type RedisClient = {
  set: (
    key: string,
    value: string,
    options: { NX: true; EX: number },
  ) => Promise<string | null>;
  on?: (event: string, handler: (err: unknown) => void) => void;
};

/**
 * Order-preserving Map exploits insertion order for cheap LRU semantics:
 * on every hit we delete + re-insert so the touched key becomes most
 * recent; size is capped via shift of the oldest key on overflow.
 */
class InMemoryLru {
  private readonly entries = new Map<string, true>();
  private readonly max: number;

  constructor(max = MAX_ENTRIES) {
    this.max = max;
  }

  /** Returns true when the key was newly inserted, false when it
   *  collided (i.e. we've seen this event before). */
  insert(key: string): boolean {
    if (this.entries.has(key)) {
      // Touch so duplicates from the same key stay live as long as
      // they keep arriving — important for retry storms.
      this.entries.delete(key);
      this.entries.set(key, true);
      return false;
    }
    this.entries.set(key, true);
    if (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return true;
  }

  /** Test-only: drain everything. */
  clear(): void {
    this.entries.clear();
  }

  /** Test-only: current size. */
  size(): number {
    return this.entries.size;
  }
}

export interface DedupeOptions {
  /** Override the LRU bound for tests. */
  max?: number;
  /** Optional Redis client (already connected); when provided dedupe
   *  uses NX-set so the check is cross-process. */
  redis?: RedisClient | null;
}

export class WebhookDedupe {
  private readonly lru: InMemoryLru;
  private readonly redis: RedisClient | null;
  private redisDegraded = false;

  constructor(opts: DedupeOptions = {}) {
    this.lru = new InMemoryLru(opts.max);
    this.redis = opts.redis ?? null;
  }

  /**
   * Returns `true` when this is the first time we've seen the key
   * (caller should process the event), `false` when it's a duplicate.
   */
  async seenBefore(channelType: string, eventId: string): Promise<boolean> {
    const key = `${channelType}:${eventId}`;
    // Always feed the in-memory LRU so we keep a hot dedupe layer even
    // when Redis is the source of truth.
    const fresh = this.lru.insert(key);

    if (this.redis && !this.redisDegraded) {
      try {
        const reply = await this.redis.set(
          `codespar:dedupe:${key}`,
          "1",
          { NX: true, EX: REDIS_TTL_SECONDS },
        );
        // node-redis returns "OK" when set, null when NX collided.
        const setOk = reply !== null && reply !== undefined;
        return setOk;
      } catch (err) {
        if (!this.redisDegraded) {
          this.redisDegraded = true;
          console.warn(
            "[whatsapp] Redis dedupe unavailable, falling back to in-memory LRU:",
            err instanceof Error ? err.message : String(err),
          );
        }
        return fresh;
      }
    }
    return fresh;
  }

  /** Test-only: reset internal state. */
  reset(): void {
    this.lru.clear();
    this.redisDegraded = false;
  }

  /** Test-only: current LRU size. */
  size(): number {
    return this.lru.size();
  }
}
