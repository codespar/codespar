/**
 * Identity Resolver — Maps channel-specific user IDs to a unified identity
 * with an assigned RBAC role.
 *
 * MVP implementation: in-memory store.  Unrecognised users default to
 * "read-only" so the system is deny-by-default.
 */

import type { ChannelType } from "../types/normalized-message.js";
import type { Role } from "./rbac.js";

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

  /**
   * Reverse index: "channelType:channelUserId" → internal user id.
   * Rebuilt on every registerUser call so lookups are O(1).
   */
  private channelIndex: Map<string, string> = new Map();

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
