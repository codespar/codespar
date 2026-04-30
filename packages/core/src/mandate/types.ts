/**
 * Mandate primitive — OSS reference impl.
 *
 * F2.M1.3 of the F3.M2 sequence. Provides a self-host-ready
 * mandate primitive that closes the I-3 self-host parity gap:
 * before this module existed, the only mandate impl lived in
 * @codespar-enterprise/mandate, so OSS deployments couldn't run
 * the meta-tools surface that depends on mandate verification.
 *
 * Wire-compatible with @codespar-enterprise/mandate (same Mandate
 * interface, same MandateBackend interface, same HMAC-SHA256
 * signature payload). A managed-tier deployment can swap in the
 * Postgres backend; a self-hoster keeps the file-backed reference
 * impl shipped here.
 */

/** A mandate is a signed proof of authorization for a payment.
 *  Fields and semantics match the enterprise package's Mandate
 *  interface so an agent's code that issues, verifies, or revokes
 *  mandates against either backend is byte-for-byte portable. */
export interface Mandate {
  id: string;
  type: "payment" | "subscription" | "delegation";
  /** User who approved the mandate (typically a Clerk user id or
   *  external operator identifier). */
  authorizedBy: string;
  /** Agent executing under the mandate's authority. */
  agentId: string;
  amount: number;
  currency: string;
  /** For delegation type: max amount per individual transaction. */
  maxAmount?: number;
  description: string;
  conditions: string[];
  /** HMAC-SHA256 hex digest covering id + agentId + amount +
   *  currency + expiresAt. */
  signature: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
  revokedAt?: string;
  /** Tenant scope. Required when running against multi-tenant
   *  backends; optional in single-tenant self-host deployments. */
  orgId?: string;
}

/**
 * Storage interface for mandate persistence. The OSS reference
 * impl ships two backends out of the box:
 *
 *   - InMemoryMandateBackend   — process-local, ephemeral; useful
 *                                for tests and single-shot scripts
 *   - FileMandateBackend       — JSON file on disk with atomic
 *                                write-through; the recommended
 *                                self-host default
 *
 * A managed-tier deployment swaps in the Postgres backend from
 * `@codespar-enterprise/mandate-postgres` against the same
 * interface — agent code is portable across both.
 *
 * Atomicity rule: `markUsed` and `markRevoked` MUST be atomic CAS.
 * Backends that can't guarantee atomicity (e.g. naive file writers
 * under concurrent processes) must document the constraint and
 * either reject concurrent access or upgrade to a backend that can.
 */
export interface MandateBackend {
  /** Create + store a fresh mandate. Throws if `id` already exists. */
  put(mandate: Mandate): Promise<void> | void;
  /** Look up a mandate by id. Returns undefined when absent. */
  get(id: string): Promise<Mandate | undefined> | Mandate | undefined;
  /** Atomic CAS that flips a pending mandate to used. Throws when
   *  the row is missing, already used, already revoked, or expired. */
  markUsed(id: string, usedAt: string): Promise<Mandate> | Mandate;
  /** Atomic CAS that flips a pending mandate to revoked. Throws when
   *  the row is missing or already revoked. */
  markRevoked(id: string, revokedAt: string): Promise<Mandate> | Mandate;
  /** Returns mandates that are not used, not revoked, and not expired
   *  as of the supplied `now` (caller passes its clock so tests stay
   *  deterministic). */
  getActive(now: Date): Promise<Mandate[]> | Mandate[];
}
