/**
 * Local-only revocation denylist for self-hosters.
 *
 * The managed-tier `RevocationDenylist` in
 * `@codespar-enterprise/mandate-postgres` propagates revocations
 * across worker processes via Postgres LISTEN/NOTIFY. Self-host
 * deployments running a single Node process don't need that
 * machinery — `LocalRevocationDenylist` is just a bounded in-memory
 * Set. It exists as a peer so callers using the same MandateBackend
 * shape can wire a denylist regardless of deployment model.
 *
 * Multi-process self-host should use the Postgres backend; this
 * primitive doesn't try to solve cross-process propagation.
 */

export interface LocalDenylistConfig {
  /** Hard cap on in-memory entries; FIFO-evicted past this. */
  maxSize?: number;
}

export class LocalRevocationDenylist {
  private revoked = new Set<string>();
  private order: string[] = [];
  private maxSize: number;

  constructor(config: LocalDenylistConfig = {}) {
    this.maxSize = config.maxSize ?? 10_000;
  }

  has(id: string): boolean {
    return this.revoked.has(id);
  }

  add(id: string): void {
    if (this.revoked.has(id)) return;
    this.revoked.add(id);
    this.order.push(id);
    while (this.order.length > this.maxSize) {
      const evicted = this.order.shift();
      if (evicted) this.revoked.delete(evicted);
    }
  }

  size(): number {
    return this.revoked.size;
  }
}
