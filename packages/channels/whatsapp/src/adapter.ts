/**
 * WhatsApp Channel Adapter -- via Evolution API.
 *
 * Connects to an Evolution API instance (REST wrapper over Baileys,
 * community-maintained) that handles QR pairing, session persistence,
 * reconnection, and anti-ban. Messages arrive via webhook.
 *
 * ENV:
 *   EVOLUTION_API_URL      -- Evolution API base URL (default: http://localhost:8084)
 *   EVOLUTION_API_KEY      -- API authentication key
 *   EVOLUTION_INSTANCE     -- Instance name (default: codespar)
 *   WHATSAPP_WEBHOOK_PORT  -- Port for incoming webhooks (default: 3001)
 *   WHATSAPP_WEBHOOK_URL   -- Full callback URL registered with Evolution API
 *                              (override; default derived from
 *                              WHATSAPP_WEBHOOK_HOST + WHATSAPP_WEBHOOK_PORT).
 *   WHATSAPP_WEBHOOK_HOST  -- Hostname Evolution API uses to reach this runtime
 *                              (default: host.docker.internal; in compose set
 *                              to the runtime's service name).
 *   WHATSAPP_BOT_MENTION   -- Bot mention pattern (default: @codespar)
 */

import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type {
  Attachment,
  ChannelAdapter,
  ChannelCapabilities,
  ChannelResponse,
  MessageHandler,
  NormalizedMessage,
} from "@codespar/core";
import {
  EVOLUTION_SIGNATURE_HEADER,
  isStrictMode,
  verifyEvolutionSignature,
} from "./signature.js";
import { WebhookDedupe } from "./dedupe.js";

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
      imageMessage?: {
        url?: string;
        mediaUrl?: string;
        directPath?: string;
        mimetype?: string;
        caption?: string;
      };
      documentMessage?: {
        url?: string;
        mediaUrl?: string;
        mimetype?: string;
        fileName?: string;
      };
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
  /** One-time WARN log gate for the relaxed signature mode (F10.M3). */
  private warnedAboutUnsignedWebhook = false;
  /** Idempotency state for inbound webhook events (F10.M4 / #366). */
  private readonly dedupe = new WebhookDedupe();

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
      // 2. Try to create the instance (idempotent -- may already exist)
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
    // Preserve pairing across restarts: do NOT call /instance/logout/. The
    // Evolution API container keeps the paired session in its named volume
    // (`evolution_data`); deleting that volume is the only way to force a
    // re-pair on next start (F10.M1 / #365).
    if (this.webhookServer) {
      await this.webhookServer.close();
      this.webhookServer = null;
    }

    console.log("[whatsapp] Disconnected (pairing preserved)");
  }

  // ---------------------------------------------------------------------------
  // onMessage()
  // ---------------------------------------------------------------------------

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  // ---------------------------------------------------------------------------
  // sendToChannel() -- send to group or individual chat
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
  // sendDM() -- send private message to a user
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
        console.log("[whatsapp] No QR code returned -- instance may already be paired.");
        return;
      }

      // If it's a raw QR code string (not a data URI), render it as
      // ASCII so the operator can scan straight from the terminal
      // (F10.M4 / #366). Base64 data URIs go through the dashboard.
      if (!qrString.startsWith("data:")) {
        console.log("[whatsapp] Scan the QR code with your WhatsApp app.");
        await renderQrAscii(qrString);
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

    // ── Signature verification preHandler (F10.M3 / #364) ──────────
    // Runs BEFORE any payload parsing so an unauthenticated request
    // never reaches `messages.upsert` decoding. The bridge handler is
    // only invoked when the verdict is { ok: true }. Health endpoint
    // is exempt (it returns no inbound data and is the operator's
    // "is this thing up?" probe).
    server.addHook("preHandler", async (request, reply) => {
      if (request.routerPath === "/health" || request.url === "/health") return;
      const secret = process.env.EVOLUTION_WEBHOOK_SECRET;
      const strict = isStrictMode(process.env.WHATSAPP_WEBHOOK_STRICT_MODE);
      const providedHeader = request.headers[EVOLUTION_SIGNATURE_HEADER] as
        | string
        | undefined;
      const verdict = verifyEvolutionSignature({ providedHeader, secret, strict });
      if (!verdict.ok) {
        reply.status(401).send({ error: "invalid_signature", reason: verdict.reason });
        return reply;
      }
      if (verdict.reason === "no_secret_relaxed" && !this.warnedAboutUnsignedWebhook) {
        this.warnedAboutUnsignedWebhook = true;
        console.warn(
          "[whatsapp] EVOLUTION_WEBHOOK_SECRET not set — webhook accepts unsigned requests. Set WHATSAPP_WEBHOOK_STRICT_MODE=true to reject in production.",
        );
      }
    });

    server.post("/webhook", async (request) => {
      if (!this.messageHandler) return { ok: true };

      const payload = request.body as EvolutionWebhookPayload;

      // Only handle message upsert events
      if (payload.event !== "messages.upsert") return { ok: true };

      const { key, message, messageTimestamp } = payload.data;

      // Skip our own messages
      if (key.fromMe) return { ok: true };

      // Skip messages with no content at all
      if (!message) return { ok: true };

      // Idempotency: short-circuit duplicate Evolution-API redeliveries
      // (F10.M4 / #366). The dedupe key is (channelType, key.id) so the
      // agent is only invoked once per logical message.
      if (key.id) {
        const fresh = await this.dedupe.seenBefore("whatsapp", key.id);
        if (!fresh) return { ok: true };
      }

      const rawText =
        message.conversation ||
        message.extendedTextMessage?.text ||
        message.imageMessage?.caption ||
        "";

      const remoteJid = key.remoteJid;
      if (!remoteJid) return { ok: true };

      // Extract attachments (images, documents). Pass-through only —
      // M4 explicitly does NOT download / OCR / vision-pipeline the
      // remote content; every non-text attachment gets a one-line WARN
      // log so operators know an inbound message had media we ignored.
      const attachments: Attachment[] = [];

      if (message.imageMessage) {
        const mediaUrl =
          message.imageMessage.url ||
          message.imageMessage.mediaUrl ||
          message.imageMessage.directPath;
        if (mediaUrl) {
          const mimeType = message.imageMessage.mimetype || "image/jpeg";
          attachments.push({
            type: "image",
            url: mediaUrl,
            mimeType,
            filename: "whatsapp_image.jpg",
          });
          console.warn(
            "[whatsapp] attachment received but not retrieved",
            JSON.stringify({ messageId: key.id ?? null, type: "image", mimeType }),
          );
        }
      }

      if (message.documentMessage) {
        const mediaUrl =
          message.documentMessage.url ||
          message.documentMessage.mediaUrl;
        if (mediaUrl) {
          const mimeType = message.documentMessage.mimetype || "application/octet-stream";
          const isImage = mimeType.startsWith("image/");
          attachments.push({
            type: isImage ? "image" : "file",
            url: mediaUrl,
            mimeType,
            filename: message.documentMessage.fileName || "document",
          });
          console.warn(
            "[whatsapp] attachment received but not retrieved",
            JSON.stringify({
              messageId: key.id ?? null,
              type: isImage ? "image" : "document",
              mimeType,
            }),
          );
        }
      }

      // Skip messages with no text and no attachments
      if (!rawText && attachments.length === 0) return { ok: true };

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
        ...(attachments.length > 0 ? { attachments } : {}),
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

  /**
   * Resolve the URL Evolution API should POST inbound events to.
   *
   * Resolution order:
   *   1. WHATSAPP_WEBHOOK_URL (full URL override)
   *   2. http://${WHATSAPP_WEBHOOK_HOST}:${WHATSAPP_WEBHOOK_PORT}/webhook
   *   3. host.docker.internal default (local dev: Evolution in Docker,
   *      runtime on host).
   */
  private resolveWebhookUrl(): string {
    const explicit = process.env.WHATSAPP_WEBHOOK_URL?.trim();
    if (explicit) return explicit;
    const host = process.env.WHATSAPP_WEBHOOK_HOST?.trim() || "host.docker.internal";
    return `http://${host}:${this.webhookPort}/webhook`;
  }

  /** Register this webhook URL with the Evolution API instance. */
  private async registerWebhook(): Promise<void> {
    const webhookUrl = this.resolveWebhookUrl();

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

/**
 * Render a QR-code payload as ASCII to stdout. Uses qrcode-terminal
 * when available so the operator can scan from the terminal without
 * leaving the runtime. Falls back to a one-line value preview when
 * the dependency is unavailable (graceful in tests / minimal builds).
 *
 * Exported for unit testing — the test mocks `qrcode-terminal` so the
 * branch is exercised without requiring the real dep to be installed.
 */
export async function renderQrAscii(value: string): Promise<void> {
  try {
    type QrTerminal = {
      generate: (text: string, options?: { small?: boolean }) => void;
    };
    const mod = (await import("qrcode-terminal")) as
      | QrTerminal
      | { default?: QrTerminal };
    const qrTerm: QrTerminal | undefined =
      "generate" in mod ? mod : mod.default;
    if (qrTerm && typeof qrTerm.generate === "function") {
      qrTerm.generate(value, { small: true });
      return;
    }
    throw new Error("qrcode-terminal module missing `generate`");
  } catch {
    console.log(
      `[whatsapp] QR code value: ${value.substring(0, 60)}${value.length > 60 ? "..." : ""}`,
    );
    console.log(
      "[whatsapp] Install qrcode-terminal to render the QR as ASCII in the terminal.",
    );
  }
}
