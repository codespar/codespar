/**
 * Channel Router — Per-channel alert routing.
 *
 * Routes alerts (deploy, error, incident, etc.) to specific channels
 * instead of broadcasting to every adapter's last-known channel.
 *
 * Example: send deploy alerts to #devops on Slack, error alerts to
 * #incidents on Discord, etc.
 */

import type { StorageProvider } from "../storage/types.js";

/** A single routing rule: "send these alert types to this channel" */
export interface ChannelRoute {
  /** Adapter type: "slack", "discord", "whatsapp", "telegram" */
  channelType: string;
  /** Platform-specific channel ID (Slack channel ID, Discord channel ID, etc.) */
  channelId: string;
  /** Human-readable name: "#devops", "Deploy Alerts group", etc. */
  channelName?: string;
  /** Alert types this route handles: ["deploy", "error", "incident", "all"] */
  alertTypes: string[];
  /** Only match alerts from this project (empty/undefined = all projects) */
  projectFilter?: string;
}

/** Storage key used to persist routes via StorageProvider.setMemory/getMemory */
const STORAGE_AGENT_ID = "system";
const STORAGE_KEY = "channel-routes";

export class ChannelRouter {
  private routes: ChannelRoute[] = [];

  /** Add a routing rule. Replaces any existing route for the same channelType+channelId. */
  addRoute(route: ChannelRoute): void {
    // Remove existing route for same target to avoid duplicates
    this.routes = this.routes.filter(
      (r) => !(r.channelType === route.channelType && r.channelId === route.channelId),
    );
    this.routes.push(route);
  }

  /** Remove a route by channelType + channelId. */
  removeRoute(channelType: string, channelId: string): void {
    this.routes = this.routes.filter(
      (r) => !(r.channelType === channelType && r.channelId === channelId),
    );
  }

  /**
   * Get channels that should receive a given alert type, optionally filtered by project.
   *
   * A route matches if:
   * 1. Its alertTypes includes the given alertType OR includes "all"
   * 2. Its projectFilter matches the given projectId (or projectFilter is empty/undefined)
   *
   * Returns an empty array if no routes match — callers should fall back to broadcast.
   */
  getTargets(alertType: string, projectId?: string): ChannelRoute[] {
    return this.routes.filter((route) => {
      // Check alert type match
      const alertMatch =
        route.alertTypes.includes(alertType) || route.alertTypes.includes("all");
      if (!alertMatch) return false;

      // Check project filter
      if (route.projectFilter && projectId) {
        return route.projectFilter === projectId;
      }
      // If route has a projectFilter but no projectId was given, skip this route
      if (route.projectFilter && !projectId) {
        return false;
      }

      return true;
    });
  }

  /** Load routes from storage (via agent memory). */
  async loadFromStorage(storage: StorageProvider): Promise<void> {
    const stored = await storage.getMemory(STORAGE_AGENT_ID, STORAGE_KEY);
    if (Array.isArray(stored)) {
      this.routes = stored as ChannelRoute[];
    }
  }

  /** Persist routes to storage (via agent memory). */
  async saveToStorage(storage: StorageProvider): Promise<void> {
    await storage.setMemory(STORAGE_AGENT_ID, STORAGE_KEY, this.routes);
  }

  /** Return all configured routes. */
  list(): ChannelRoute[] {
    return [...this.routes];
  }

  /** Check whether any routes are configured. */
  hasRoutes(): boolean {
    return this.routes.length > 0;
  }
}
