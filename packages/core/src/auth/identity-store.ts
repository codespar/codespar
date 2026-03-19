/**
 * Identity Store — Persists user identities across channels.
 *
 * Maps channel-specific user IDs to unified CodeSpar identities.
 * Enables cross-channel approval (approve on Slack what was requested on WhatsApp).
 */

import type { StorageProvider } from "../storage/types.js";
import type { UserIdentity } from "./identity.js";
import type { Role } from "./rbac.js";
import type { ChannelType } from "../types/normalized-message.js";

export class IdentityStore {
  private storage: StorageProvider;
  private identities: Map<string, UserIdentity> = new Map();
  private channelIndex: Map<string, string> = new Map(); // "slack:U123" -> userId

  constructor(storage: StorageProvider) {
    this.storage = storage;
  }

  /** Load identities from storage on startup */
  async load(): Promise<void> {
    const data = await this.storage.getMemory("_system", "identities");
    if (data && typeof data === "object") {
      const entries = data as Record<string, any>;
      for (const [id, identity] of Object.entries(entries)) {
        const user: UserIdentity = {
          id,
          displayName: identity.displayName,
          role: identity.role as Role,
          channelIdentities: new Map(Object.entries(identity.channels || {})) as Map<ChannelType, string>,
        };
        this.identities.set(id, user);
        // Build reverse index
        for (const [channelType, channelUserId] of user.channelIdentities) {
          this.channelIndex.set(`${channelType}:${channelUserId}`, id);
        }
      }
    }
  }

  /** Save identities to storage */
  async save(): Promise<void> {
    const data: Record<string, any> = {};
    for (const [id, user] of this.identities) {
      data[id] = {
        displayName: user.displayName,
        role: user.role,
        channels: Object.fromEntries(user.channelIdentities),
      };
    }
    await this.storage.setMemory("_system", "identities", data);
  }

  /** Register a new user or update existing */
  async registerUser(params: {
    displayName: string;
    role: Role;
    channelType: ChannelType;
    channelUserId: string;
  }): Promise<UserIdentity> {
    // Check if this channel identity already maps to a user
    const existingId = this.channelIndex.get(
      `${params.channelType}:${params.channelUserId}`,
    );

    if (existingId) {
      const existing = this.identities.get(existingId)!;
      existing.displayName = params.displayName;
      existing.role = params.role;
      await this.save();
      return existing;
    }

    // Create new identity
    const id = `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const user: UserIdentity = {
      id,
      displayName: params.displayName,
      role: params.role,
      channelIdentities: new Map([[params.channelType, params.channelUserId]]),
    };

    this.identities.set(id, user);
    this.channelIndex.set(
      `${params.channelType}:${params.channelUserId}`,
      id,
    );
    await this.save();
    return user;
  }

  /** Link an additional channel to an existing user */
  async linkChannel(
    userId: string,
    channelType: ChannelType,
    channelUserId: string,
  ): Promise<boolean> {
    const user = this.identities.get(userId);
    if (!user) return false;

    user.channelIdentities.set(channelType, channelUserId);
    this.channelIndex.set(`${channelType}:${channelUserId}`, userId);
    await this.save();
    return true;
  }

  /** Resolve a channel user to their unified identity */
  resolve(
    channelType: ChannelType,
    channelUserId: string,
  ): UserIdentity | null {
    const userId = this.channelIndex.get(`${channelType}:${channelUserId}`);
    if (!userId) return null;
    return this.identities.get(userId) || null;
  }

  /** Get display name for a channel user (falls back to ID) */
  getDisplayName(channelType: ChannelType, channelUserId: string): string {
    const user = this.resolve(channelType, channelUserId);
    return user?.displayName || channelUserId;
  }

  /** Get all registered identities */
  getAll(): UserIdentity[] {
    return Array.from(this.identities.values());
  }
}
