/**
 * WhatsApp Channel Adapter — via Evolution API.
 *
 * Instead of managing Baileys directly, we connect to an Evolution API
 * instance that handles QR pairing, session persistence, reconnection,
 * and anti-ban. Messages arrive via webhook.
 *
 * ENV:
 *   EVOLUTION_API_URL      — Evolution API base URL (default: http://localhost:8084)
 *   EVOLUTION_API_KEY      — API authentication key
 *   EVOLUTION_INSTANCE     — Instance name (default: codespar)
 *   WHATSAPP_WEBHOOK_PORT  — Port for incoming webhooks (default: 3001)
 *   WHATSAPP_BOT_MENTION   — Bot mention pattern (default: @codespar)
 */

import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelResponse,
  MessageHandler,
  NormalizedMessage,
} from "@codespar/core";

// ---------------------------------------------------------------------------
// Evolution API webhook payload types
// ---------------------------------------------------------------------------

interface EvolutionWebhookPayload {
  event: string;
  data: {
    key: {
      remoteJid: string;
      fromMe: boolean;
      id: string;
      participant?: string;
    };
    message?: {
      conversation?: string;
      extendedTextMessage?: { text?: string };
    };
    pushName?: string;
    messageTimestamp?: number;
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class WhatsAppAdapter implements ChannelAdapter {
  readonly type = "whatsapp" as const;

  private messageHandler: MessageHandler | null = null;
  private webhookServer: FastifyInstance | null = null;

  private get apiUrl(): string {
    return process.env.EVOLUTION_API_URL || "http://localhost:8084";
  }

  private get apiKey(): string {
    return process.env.EVOLUTION_API_KEY || "";
  }

  private get instanceName(): string {
    return process.env.EVOLUTION_INSTANCE || "codespar";
  }

  private get webhookPort(): number {
    return parseInt(process.env.WHATSAPP_WEBHOOK_PORT || "3001", 10);
  }

  private get botMention(): string {
    return process.env.WHATSAPP_BOT_MENTION || "@codespar";
  }

  /** Standard headers for every Evolution API call. */
  private get headers(): Record<string, string> {
    return {
      apikey: this.apiKey,
      "Content-Type": "application/json",
    };
  }

  // ---------------------------------------------------------------------------
  // connect()
  // ---------------------------------------------------------------------------

  async connect(): Promise<void> {
    // 1. Check if instance already exists and is connected
    const connected = await this.isInstanceConnected();

    if (!connected) {
      // 2. Try to create the instance (idempotent — may already exist)
      await this.ensureInstance();

      // 3. Fetch QR code for pairing
      await this.printQRCode();
    }

    // 4. Start webhook receiver
    await this.startWebhookServer();

    // 5. Register the webhook with Evolution API
    await this.registerWebhook();

    console.log("[whatsapp] Evolution API adapter connected");
  }

  // ---------------------------------------------------------------------------
  // disconnect()
  // ---------------------------------------------------------------------------

  async disconnect(): Promise<void> {
    try {
      await fetch(`${this.apiUrl}/instance/logout/${this.instanceName}`, {
        method: "DELETE",
        headers: this.headers,
      });
    } catch {
      // Ignore errors during logout — instance may already be gone
    }

    if (this.webhookServer) {
      await this.webhookServer.close();
      this.webhookServer = null;
    }

    console.log("[whatsapp] Disconnected");
  }

  // ---------------------------------------------------------------------------
  // onMessage()
  // ---------------------------------------------------------------------------

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  // ---------------------------------------------------------------------------
  // sendToChannel() — send to group or individual chat
  // ---------------------------------------------------------------------------

  async sendToChannel(
    channelId: string,
    response: ChannelResponse
  ): Promise<void> {
    await fetch(`${this.apiUrl}/message/sendText/${this.instanceName}`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ number: channelId, text: response.text }),
    });
  }

  // ---------------------------------------------------------------------------
  // sendDM() — send private message to a user
  // ---------------------------------------------------------------------------

  async sendDM(userId: string, response: ChannelResponse): Promise<void> {
    await fetch(`${this.apiUrl}/message/sendText/${this.instanceName}`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ number: userId, text: response.text }),
    });
  }

  // ---------------------------------------------------------------------------
  // getCapabilities()
  // ---------------------------------------------------------------------------

  getCapabilities(): ChannelCapabilities {
    return {
      threads: false,
      buttons: false,
      modals: false,
      messageEdit: false,
      ephemeral: false,
      reactions: true,
    };
  }

  // ---------------------------------------------------------------------------
  // healthCheck()
  // ---------------------------------------------------------------------------

  async healthCheck(): Promise<boolean> {
    return this.isInstanceConnected();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Check whether the Evolution API instance is connected ("open"). */
  private async isInstanceConnected(): Promise<boolean> {
    try {
      const res = await fetch(
        `${this.apiUrl}/instance/connectionState/${this.instanceName}`,
        { headers: this.headers }
      );
      if (!res.ok) return false;
      const body = (await res.json()) as { instance?: { state?: string } };
      return body?.instance?.state === "open";
    } catch {
      return false;
    }
  }

  /** Create the Evolution API instance if it doesn't exist yet. */
  private async ensureInstance(): Promise<void> {
    try {
      await fetch(`${this.apiUrl}/instance/create`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({
          instanceName: this.instanceName,
          integration: "WHATSAPP-BAILEYS",
          qrcode: true,
        }),
      });
    } catch (err) {
      console.warn("[whatsapp] Could not create instance:", err);
    }
  }

  /** Fetch the QR code from Evolution API and print it to the terminal. */
  private async printQRCode(): Promise<void> {
    try {
      const res = await fetch(
        `${this.apiUrl}/instance/connect/${this.instanceName}`,
        { headers: this.headers }
      );
      if (!res.ok) {
        console.warn("[whatsapp] Could not fetch QR code:", res.statusText);
        return;
      }

      const body = (await res.json()) as { base64?: string; code?: string };

      // Evolution API may return the raw code string or a base64-encoded image.
      // If we get a raw code, print it directly; otherwise decode the base64.
      const qrString = body.code || body.base64 || "";
      if (!qrString) {
        console.log("[whatsapp] No QR code returned — instance may already be paired.");
        return;
      }

      // If it's a raw QR code string (not a data URI), print it directly
      if (!qrString.startsWith("data:")) {
        console.log("[whatsapp] Scan the QR code with your WhatsApp app.");
        console.log(`[whatsapp] QR code value: ${qrString.substring(0, 60)}...`);
      } else {
        console.log("[whatsapp] QR code received as base64 image.");
        console.log("[whatsapp] Open the Evolution API dashboard to scan the QR code.");
      }
    } catch (err) {
      console.warn("[whatsapp] Error fetching QR code:", err);
    }
  }

  /** Start a Fastify server to receive Evolution API webhook events. */
  private async startWebhookServer(): Promise<void> {
    if (this.webhookServer) return;

    const server = Fastify({ logger: false });

    server.post("/webhook", async (request) => {
      if (!this.messageHandler) return { ok: true };

      const payload = request.body as EvolutionWebhookPayload;

      // Only handle message upsert events
      if (payload.event !== "messages.upsert") return { ok: true };

      const { key, message, messageTimestamp } = payload.data;

      // Skip our own messages
      if (key.fromMe) return { ok: true };

      // Skip non-text messages
      if (!message) return { ok: true };

      const rawText =
        message.conversation ||
        message.extendedTextMessage?.text ||
        "";

      if (!rawText) return { ok: true };

      const remoteJid = key.remoteJid;
      if (!remoteJid) return { ok: true };

      const isDM = !remoteJid.endsWith("@g.us");
      const mentionPattern = this.botMention.toLowerCase();
      const isMentioningBot = rawText.toLowerCase().includes(mentionPattern);

      // In groups, only process messages that mention the bot
      if (!isDM && !isMentioningBot) return { ok: true };

      // Strip the @mention from the text
      const cleanText = rawText
        .replace(new RegExp(mentionPattern, "gi"), "")
        .trim();

      const normalized: NormalizedMessage = {
        id: key.id || randomUUID(),
        channelType: "whatsapp",
        channelId: remoteJid,
        channelUserId: key.participant || remoteJid,
        isDM,
        isMentioningBot: isDM || isMentioningBot,
        text: cleanText,
        timestamp: new Date((messageTimestamp ?? 0) * 1000),
      };

      void this.messageHandler(normalized);
      return { ok: true };
    });

    // Health endpoint for the webhook server itself
    server.get("/health", async () => ({ ok: true }));

    await server.listen({ port: this.webhookPort, host: "0.0.0.0" });
    this.webhookServer = server;
    console.log(`[whatsapp] Webhook server listening on port ${this.webhookPort}`);
  }

  /** Register this webhook URL with the Evolution API instance. */
  private async registerWebhook(): Promise<void> {
    const webhookUrl = `http://host.docker.internal:${this.webhookPort}/webhook`;

    try {
      await fetch(`${this.apiUrl}/webhook/set/${this.instanceName}`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({
          url: webhookUrl,
          events: ["MESSAGES_UPSERT"],
        }),
      });
      console.log(`[whatsapp] Webhook registered: ${webhookUrl}`);
    } catch (err) {
      console.warn("[whatsapp] Failed to register webhook:", err);
    }
  }
}
