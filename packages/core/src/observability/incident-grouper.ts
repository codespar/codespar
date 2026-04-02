/**
 * Incident Grouper — deduplicates alerts within a time window.
 *
 * Groups identical errors (by project + message hash) within a 5-minute window
 * into a single incident, preventing alert fatigue in Slack/Discord/WhatsApp.
 */

import { createHash } from "node:crypto";

export interface IncidentGroup {
  id: string;
  hash: string;
  project: string;
  errorSummary: string;
  severity: "low" | "medium" | "high" | "critical";
  count: number;
  firstSeen: number;
  lastSeen: number;
  acknowledged: boolean;
  analysis?: unknown;
}

export interface GroupResult {
  isNew: boolean;
  incident: IncidentGroup;
}

export class IncidentGrouper {
  private groups = new Map<string, IncidentGroup>();
  private windowMs: number;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(windowMs = 5 * 60 * 1000) {
    this.windowMs = windowMs;
    this.cleanupInterval = setInterval(() => this.cleanup(), 15 * 60 * 1000);
    if (this.cleanupInterval.unref) this.cleanupInterval.unref();
  }

  private makeHash(project: string, errorMessage: string): string {
    return createHash("sha256")
      .update(`${project}:${errorMessage.slice(0, 100)}`)
      .digest("hex")
      .slice(0, 16);
  }

  maybeGroup(
    alert: { project: string; errorMessage?: string; type: string },
    analysis?: { severity?: string; rootCause?: string },
  ): GroupResult {
    const errorMsg = alert.errorMessage || alert.type;
    const h = this.makeHash(alert.project, errorMsg);
    const now = Date.now();

    const existing = this.groups.get(h);
    if (existing && now - existing.lastSeen < this.windowMs) {
      existing.count++;
      existing.lastSeen = now;
      if (analysis) existing.analysis = analysis;
      return { isNew: false, incident: existing };
    }

    const incident: IncidentGroup = {
      id: `inc-${h}-${now}`,
      hash: h,
      project: alert.project,
      errorSummary: errorMsg.slice(0, 200),
      severity: (analysis?.severity as IncidentGroup["severity"]) || "medium",
      count: 1,
      firstSeen: now,
      lastSeen: now,
      acknowledged: false,
      analysis,
    };
    this.groups.set(h, incident);
    return { isNew: true, incident };
  }

  acknowledge(id: string): boolean {
    for (const group of this.groups.values()) {
      if (group.id === id) {
        group.acknowledged = true;
        return true;
      }
    }
    return false;
  }

  getActive(): IncidentGroup[] {
    const cutoff = Date.now() - 60 * 60 * 1000;
    return Array.from(this.groups.values())
      .filter((g) => g.lastSeen > cutoff)
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }

  private cleanup(): void {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [hash, group] of this.groups) {
      if (group.lastSeen < cutoff) this.groups.delete(hash);
    }
  }

  destroy(): void {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    this.groups.clear();
  }
}

/** Singleton instance for production use. */
export const incidentGrouper = new IncidentGrouper();
