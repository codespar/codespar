/**
 * A2A Registry — TTL-based cache for external Agent Cards.
 *
 * Avoids repeated discovery calls by caching cards with a configurable TTL.
 * Also provides skill lookup across all known external agents.
 */

import { createLogger } from "../observability/logger.js";
import type { ExternalAgentCard } from "../types/a2a.js";
import type { A2AClient } from "./client.js";

const log = createLogger("a2a/registry");

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class A2ARegistry {
  private cache = new Map<string, ExternalAgentCard>();
  private ttlMs: number;

  constructor(ttlMs?: number) {
    this.ttlMs = ttlMs ?? DEFAULT_TTL_MS;
  }

  /**
   * Return a cached card if still fresh, otherwise discover and cache.
   */
  async getOrDiscover(
    agentUrl: string,
    client: A2AClient,
  ): Promise<ExternalAgentCard> {
    const key = normalizeKey(agentUrl);
    const cached = this.cache.get(key);

    if (cached && !this.isExpired(cached)) {
      log.debug("Cache hit for external agent", { url: key });
      return cached;
    }

    log.info("Discovering external agent (cache miss or expired)", {
      url: key,
    });

    const card = await client.discover(agentUrl);
    this.cache.set(key, card);
    return card;
  }

  /**
   * Find which cached external agent provides a given skill ID.
   * Returns the first match (does NOT trigger discovery).
   */
  findSkill(
    skillId: string,
  ): { agentUrl: string; card: ExternalAgentCard } | undefined {
    for (const [agentUrl, card] of this.cache) {
      for (const agent of card.agents) {
        const match = agent.skills.find((s) => s.id === skillId);
        if (match) {
          return { agentUrl, card };
        }
      }
    }
    return undefined;
  }

  /**
   * Manually register an external agent card (e.g., from an allowlist).
   * Overwrites any existing entry for the same URL.
   */
  register(agentUrl: string, card: ExternalAgentCard): void {
    const key = normalizeKey(agentUrl);
    this.cache.set(key, card);
    log.info("Registered external agent", { url: key, name: card.name });
  }

  /**
   * List all known external agent cards (including expired ones).
   */
  list(): ExternalAgentCard[] {
    return Array.from(this.cache.values());
  }

  /**
   * Clear all cached entries.
   */
  clear(): void {
    this.cache.clear();
    log.info("A2A registry cleared");
  }

  // ── Internal ─────────────────────────────────────────────────────────

  private isExpired(card: ExternalAgentCard): boolean {
    return Date.now() - card.discoveredAt > this.ttlMs;
  }
}

/** Normalize URL to use as cache key (strip trailing slashes). */
function normalizeKey(url: string): string {
  return url.replace(/\/+$/, "");
}
