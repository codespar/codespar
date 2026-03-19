/**
 * Identity Resolver — Maps channel-specific user IDs to a unified identity
 * with an assigned RBAC role.
 *
 * MVP implementation: in-memory store.  Unrecognised users default to
 * "read-only" so the system is deny-by-default.
 *
 * When an IdentityStore is attached (via setStore), the resolver delegates
 * lookups to persistent storage, enabling cross-channel identity resolution.
 */

import type { ChannelType } from "../types/normalized-message.js";
import type { Role } from "./rbac.js";
import type { IdentityStore } from "./identity-store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UserIdentity {
  /** Internal user ID */
  id: string;

  /** Human-readable name */
  displayName: string;

  /** RBAC role */
  role: Role;

  /** channelType → channel-specific user ID */
  channelIdentities: Map<ChannelType, string>;
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export class IdentityResolver {
  private users: Map<string, UserIdentity> = new Map();
  private store: IdentityStore | null = null;

  /**
   * Reverse index: "channelType:channelUserId" → internal user id.
   * Rebuilt on every registerUser call so lookups are O(1).
   */
  private channelIndex: Map<string, string> = new Map();

  /**
   * Attach a persistent IdentityStore.
   * Syncs all store identities into the in-memory resolver so that
   * both lookup paths return consistent results.
   */
  setStore(store: IdentityStore): void {
    this.store = store;
    // Sync: load all store identities into the resolver
    for (const user of store.getAll()) {
      this.registerUser(user);
    }
  }

  /** Get the attached store (if any). */
  getStore(): IdentityStore | null {
    return this.store;
  }

  /** Register (or update) a user identity. */
  registerUser(identity: UserIdentity): void {
    this.users.set(identity.id, identity);

    for (const [channelType, channelUserId] of identity.channelIdentities) {
      this.channelIndex.set(
        this.channelKey(channelType, channelUserId),
        identity.id,
      );
    }
  }

  /** Resolve a user by channel coordinates. Returns null if unknown. */
  resolveByChannel(
    channelType: ChannelType,
    channelUserId: string,
  ): UserIdentity | null {
    // Try persistent store first
    if (this.store) {
      const storeUser = this.store.resolve(channelType, channelUserId);
      if (storeUser) return storeUser;
    }
    // Fall back to in-memory
    const userId = this.channelIndex.get(
      this.channelKey(channelType, channelUserId),
    );
    if (!userId) return null;
    return this.users.get(userId) ?? null;
  }

  /**
   * Convenience: get role for a channel user.
   * Returns "read-only" for unknown users (deny-by-default).
   */
  getRole(channelType: ChannelType, channelUserId: string): Role {
    // Try store first
    if (this.store) {
      const user = this.store.resolve(channelType, channelUserId);
      if (user) return user.role;
    }
    // Fall back to in-memory
    const identity = this.resolveByChannel(channelType, channelUserId);
    return identity?.role ?? "read-only";
  }

  /** Get a user by internal ID. */
  getUserById(id: string): UserIdentity | null {
    return this.users.get(id) ?? null;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private channelKey(channelType: ChannelType, channelUserId: string): string {
    return `${channelType}:${channelUserId}`;
  }
}
