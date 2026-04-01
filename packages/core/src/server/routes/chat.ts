/**
 * Chat routes — web chat endpoint + streaming SSE chat.
 */

import { randomUUID } from "node:crypto";
import { createLogger } from "../../observability/logger.js";
import { metrics } from "../../observability/metrics.js";
import { parseIntent } from "../../router/intent-parser.js";
import type { RouteFn, ServerContext } from "./types.js";
import type { ChannelType, NormalizedMessage } from "../../types/normalized-message.js";
import { chatMessageBody, parseBody } from "./schemas.js";

const log = createLogger("routes/chat");

export function registerChatRoutes(route: RouteFn, ctx: ServerContext): void {
    // ── Web Chat endpoint ─────────────────────────────────────────
    route("post", "/api/chat", async (request: any, reply: any) => {
      const { data: body, error } = parseBody(chatMessageBody, request.body);
      if (!body) {
        return reply.code(400).send({ error: error || "Invalid request body" });
      }
      const text = body.text.trim();

      const orgId = ctx.getOrgId(request);
      const agentId = body.agentId || "agent-default";

      // Build a normalized message from the web chat request
      const message: NormalizedMessage = {
        id: randomUUID(),
        channelType: "web",
        channelId: `web-${orgId}`,
        channelUserId: `web-user-${orgId}`,
        isDM: true,
        isMentioningBot: true,
        text,
        timestamp: new Date(),
        attachments: body.imageUrls?.map((img) => ({
          type: "image" as const,
          url: img.url,
          mimeType: img.mimeType,
        })),
      };

      const intent = await parseIntent(text);

      let responseText = `[${agentId}] No agent available to handle this message.`;

      try {
        if (ctx.chatHandler) {
          const response = await ctx.chatHandler(message, orgId);
          responseText = response?.text || responseText;
        }
      } catch (err) {
        responseText = `Error: ${err instanceof Error ? err.message : "Unknown error"}`;
      }

      // Audit log
      const storage = ctx.getOrgStorage(orgId);
      if (storage) {
        try {
          await storage.appendAudit({
            actorType: "user",
            actorId: message.channelUserId,
            action: intent.type === "unknown" ? "chat.message" : `${intent.type}.executed`,
            result: "success",
            metadata: {
              agentId,
              channel: "web",
              detail: text.slice(0, 100),
              orgId,
            },
          });
        } catch {
          // Audit logging is best-effort
        }
      }

      reply.send({
        text: responseText,
        intent: intent.type,
        confidence: intent.confidence,
        timestamp: new Date().toISOString(),
      });
    });

    // ── Streaming Web Chat endpoint (SSE) ─────────────────────────
    route("post", "/api/chat/stream", async (request: any, reply: any) => {
      const body = request.body as {
        text?: string;
        imageUrls?: Array<{ url: string; mimeType?: string }>;
      };
      const text = String(body.text || "").trim();
      if (!text) {
        reply.code(400).send({ error: "Message text is required" });
        return;
      }

      const orgId = ctx.getOrgId(request);

      // Set SSE headers (disable buffering for real-time streaming)
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "X-Accel-Buffering": "no", // Disable nginx/proxy buffering
      });
      // Disable Node.js socket buffering for immediate delivery
      reply.raw.socket?.setNoDelay(true);

      // Send progress events as the agent works
      function sendEvent(type: string, data: unknown) {
        reply.raw.write(
          `data: ${JSON.stringify({ type, ...(data as object) })}\n\n`
        );
        // Force flush
        if (typeof (reply.raw as any).flush === "function") {
          (reply.raw as any).flush();
        }
      }

      sendEvent("progress", { message: "Parsing command..." });

      // Parse intent
      const intent = await parseIntent(text);

      sendEvent("progress", {
        message: `Understood: ${intent.type} (${(intent.confidence * 100).toFixed(0)}% confidence)`,
      });

      // Build normalized message with progress callback in metadata
      const message: NormalizedMessage = {
        id: randomUUID(),
        channelType: "web" as ChannelType,
        channelId: `web-${orgId}`,
        channelUserId: `web-user-${orgId}`,
        isDM: true,
        isMentioningBot: true,
        text,
        timestamp: new Date(),
        attachments: body.imageUrls?.map((img) => ({
          type: "image" as const,
          url: img.url,
          mimeType: img.mimeType,
        })),
        metadata: {
          onProgress: (event: unknown) => {
            const e = event as Record<string, unknown>;
            // Wrap the progress event, preserving message and code fields
            // but setting type to "progress" so the frontend handles it
            sendEvent("progress", { message: e.message, code: e.code });
          },
        },
      };

      // Send intent-specific progress messages
      if (intent.type === "instruct" || intent.type === "fix") {
        sendEvent("progress", {
          message: "Searching codebase for relevant files...",
        });
      } else if (intent.type === "review") {
        sendEvent("progress", {
          message: "Fetching PR data from GitHub...",
        });
      } else if (intent.type === "lens") {
        sendEvent("progress", {
          message: "Analyzing your data question...",
        });
      } else if (intent.type === "plan") {
        sendEvent("progress", {
          message: "Breaking down the feature into tasks...",
        });
      } else if (intent.type === "spec") {
        sendEvent("progress", {
          message: "Generating structured spec (EARS notation)...",
        });
      }

      try {
        let responseText = "No agent available.";
        if (ctx.chatHandler) {
          const response = await ctx.chatHandler(message, orgId);
          responseText = response?.text || responseText;
        }

        // Send the final response
        sendEvent("response", { text: responseText, intent: intent.type });
      } catch (err) {
        sendEvent("error", {
          message: err instanceof Error ? err.message : "Unknown error",
        });
      }

      // Close the stream
      sendEvent("done", {});
      reply.raw.end();
    });


}
