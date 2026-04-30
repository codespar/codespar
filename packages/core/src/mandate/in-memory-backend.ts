/**
 * Process-local in-memory mandate backend.
 *
 * Suitable for tests and single-shot scripts. Production self-host
 * should use `FileMandateBackend` (single-process, persistent) or
 * the Postgres backend from the managed-tier package
 * (multi-process, distributed).
 */

import type { Mandate, MandateBackend } from "./types.js";

export class InMemoryMandateBackend implements MandateBackend {
  private mandates = new Map<string, Mandate>();

  put(mandate: Mandate): void {
    if (this.mandates.has(mandate.id)) {
      throw new Error(`Mandate ${mandate.id} already exists`);
    }
    this.mandates.set(mandate.id, mandate);
  }

  get(id: string): Mandate | undefined {
    return this.mandates.get(id);
  }

  markUsed(id: string, usedAt: string): Mandate {
    const mandate = this.mandates.get(id);
    if (!mandate) throw new Error(`Mandate ${id} not found`);
    if (mandate.usedAt) throw new Error(`Mandate ${id} has already been used`);
    if (mandate.revokedAt) throw new Error(`Mandate ${id} has been revoked`);
    if (new Date(mandate.expiresAt) <= new Date()) {
      throw new Error(`Mandate ${id} has expired`);
    }
    mandate.usedAt = usedAt;
    return mandate;
  }

  markRevoked(id: string, revokedAt: string): Mandate {
    const mandate = this.mandates.get(id);
    if (!mandate) throw new Error(`Mandate ${id} not found`);
    if (mandate.revokedAt) throw new Error(`Mandate ${id} is already revoked`);
    mandate.revokedAt = revokedAt;
    return mandate;
  }

  getActive(now: Date): Mandate[] {
    return Array.from(this.mandates.values()).filter(
      (m) => !m.usedAt && !m.revokedAt && new Date(m.expiresAt) > now,
    );
  }
}
