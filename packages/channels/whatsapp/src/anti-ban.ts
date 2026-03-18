/**
 * Anti-ban strategies for WhatsApp via Baileys.
 *
 * WhatsApp aggressively detects automation. These measures reduce the
 * footprint by mimicking human behavior: random delays, typing indicators,
 * presence simulation, and rate limiting.
 */

import type { WASocket } from "@whiskeysockets/baileys";

/** Sliding-window rate limiter for outbound messages. */
interface SendRecord {
  timestamp: number;
}

export class AntiBan {
  private readonly maxPerMinute: number;
  private readonly sendLog: SendRecord[] = [];

  constructor(maxPerMinute = 30) {
    this.maxPerMinute = maxPerMinute;
  }

  // ---------------------------------------------------------------------------
  // Random delay between messages (800-2500ms)
  // ---------------------------------------------------------------------------

  async randomDelay(): Promise<void> {
    const min = 800;
    const max = 2500;
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ---------------------------------------------------------------------------
  // Simulate typing indicator before sending
  // ---------------------------------------------------------------------------

  async simulateTyping(
    sock: WASocket,
    jid: string,
    durationMs = 1500
  ): Promise<void> {
    await sock.presenceSubscribe(jid);
    await sock.sendPresenceUpdate("composing", jid);
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    await sock.sendPresenceUpdate("paused", jid);
  }

  // ---------------------------------------------------------------------------
  // Sliding-window rate limiter
  // ---------------------------------------------------------------------------

  canSend(): boolean {
    this.pruneOldRecords();
    return this.sendLog.length < this.maxPerMinute;
  }

  recordSend(): void {
    this.sendLog.push({ timestamp: Date.now() });
  }

  private pruneOldRecords(): void {
    const oneMinuteAgo = Date.now() - 60_000;
    while (this.sendLog.length > 0 && this.sendLog[0].timestamp < oneMinuteAgo) {
      this.sendLog.shift();
    }
  }

  // ---------------------------------------------------------------------------
  // Simulate presence (online/offline cycling)
  // ---------------------------------------------------------------------------

  async simulatePresence(sock: WASocket, jid: string): Promise<void> {
    await sock.presenceSubscribe(jid);
    await sock.sendPresenceUpdate("available", jid);

    // Brief "available" window, then go back to "unavailable"
    const duration = Math.floor(Math.random() * 3000) + 2000; // 2-5s
    await new Promise((resolve) => setTimeout(resolve, duration));
    await sock.sendPresenceUpdate("unavailable", jid);
  }
}
