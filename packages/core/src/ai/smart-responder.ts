/**
 * Smart Responder — Uses Claude Sonnet to generate intelligent responses
 * for open-ended questions that don't match any specific command.
 *
 * Provides the LLM with agent context (status, project, memory, audit)
 * so it can give informed, relevant answers.
 */

import { createLogger } from "../observability/logger.js";

const log = createLogger("smart");

export interface AgentContext {
  agentId: string;
  projectId: string;
  repoUrl?: string;
  autonomyLevel: number;
  tasksHandled: number;
  uptimeMinutes: number;
  recentAudit: Array<{ action: string; detail: string; timestamp: string }>;
  memoryStats: { total: number; byCategory: Record<string, number> };
  linkedChannels: string[];
}

export async function generateSmartResponse(
  question: string,
  context: AgentContext,
  imageUrls?: Array<{ url: string; mimeType?: string }>,
): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const systemPrompt = `You are a CodeSpar AI agent assistant. You help developers manage their projects, CI/CD, deployments, and code quality.

You are agent "${context.agentId}" managing project "${context.projectId}"${context.repoUrl ? ` (${context.repoUrl})` : ""}.

Current state:
- Autonomy: L${context.autonomyLevel}
- Tasks handled: ${context.tasksHandled}
- Uptime: ${context.uptimeMinutes} minutes
- Memory: ${context.memoryStats.total} entries (${Object.entries(context.memoryStats.byCategory).map(([k, v]) => `${k}: ${v}`).join(", ")})
- Connected channels: ${context.linkedChannels.join(", ") || "CLI"}

Recent activity:
${context.recentAudit.slice(0, 10).map((a) => `- ${a.action}: ${a.detail}`).join("\n") || "No recent activity"}

Available commands the user can use:
- status — check project/agent status
- instruct <task> — execute a coding task
- fix <issue> — investigate and fix a bug
- review PR #N — review a pull request
- deploy <env> — deploy to staging/production
- rollback <env> — rollback last deploy
- approve <token> — approve a pending action
- autonomy L0-L5 — change autonomy level
- logs — view recent activity
- memory — view agent memory stats
- link/unlink — manage project repo link
- register <name> — register identity
- whoami — show identity

Respond concisely and helpfully. If the user asks about capabilities, suggest relevant commands. If they ask about project status, use the context you have. Answer in the same language the user writes in.

Keep responses under 300 words. Use bullet points for lists. Be direct and actionable.`;

  try {
    // Build message content with images if present
    let userContent: string | Array<Record<string, unknown>> = question;

    if (imageUrls && imageUrls.length > 0) {
      const contentParts: Array<Record<string, unknown>> = [];

      for (const img of imageUrls) {
        try {
          const headers: Record<string, string> = {};
          if (img.url.includes("slack")) {
            const slackToken = process.env.SLACK_BOT_TOKEN;
            if (slackToken) {
              headers["Authorization"] = `Bearer ${slackToken}`;
            }
          }

          const imgRes = await fetch(img.url, { headers });
          if (imgRes.ok) {
            const buffer = await imgRes.arrayBuffer();
            const base64 = Buffer.from(buffer).toString("base64");
            const mediaType =
              img.mimeType ||
              imgRes.headers.get("content-type") ||
              "image/png";
            contentParts.push({
              type: "image",
              source: {
                type: "base64",
                media_type: mediaType,
                data: base64,
              },
            });
          }
        } catch {
          // Skip failed image downloads silently
        }
      }

      if (contentParts.length > 0) {
        contentParts.push({ type: "text", text: question });
        userContent = contentParts;
      }
    }

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.SMART_MODEL || "claude-sonnet-4-20250514",
        max_tokens: 500,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
      }),
    });

    if (!res.ok) {
      log.warn("API error", { status: res.status });
      return null;
    }

    const data = (await res.json()) as {
      content?: Array<{ text?: string }>;
    };
    return data.content?.[0]?.text || null;
  } catch (err) {
    log.error("Error", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export async function generateSmartResponseStreaming(
  question: string,
  context: AgentContext,
  onChunk: (text: string) => void,
  imageUrls?: Array<{ url: string; mimeType?: string }>,
): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const systemPrompt = `You are a CodeSpar AI agent assistant. You help developers manage their projects, CI/CD, deployments, and code quality.

You are agent "${context.agentId}" managing project "${context.projectId}"${context.repoUrl ? ` (${context.repoUrl})` : ""}.

Current state:
- Autonomy: L${context.autonomyLevel}
- Tasks handled: ${context.tasksHandled}
- Uptime: ${context.uptimeMinutes} minutes
- Memory: ${context.memoryStats.total} entries (${Object.entries(context.memoryStats.byCategory).map(([k, v]) => `${k}: ${v}`).join(", ")})
- Connected channels: ${context.linkedChannels.join(", ") || "CLI"}

Recent activity:
${context.recentAudit.slice(0, 10).map((a) => `- ${a.action}: ${a.detail}`).join("\n") || "No recent activity"}

Available commands the user can use:
- status — check project/agent status
- instruct <task> — execute a coding task
- fix <issue> — investigate and fix a bug
- review PR #N — review a pull request
- deploy <env> — deploy to staging/production
- rollback <env> — rollback last deploy
- approve <token> — approve a pending action
- autonomy L0-L5 — change autonomy level
- logs — view recent activity
- memory — view agent memory stats
- link/unlink — manage project repo link
- register <name> — register identity
- whoami — show identity

Respond concisely and helpfully. If the user asks about capabilities, suggest relevant commands. If they ask about project status, use the context you have. Answer in the same language the user writes in.

Keep responses under 300 words. Use bullet points for lists. Be direct and actionable.`;

  try {
    // Build message content with images if present
    let userContent: string | Array<Record<string, unknown>> = question;

    if (imageUrls && imageUrls.length > 0) {
      const contentParts: Array<Record<string, unknown>> = [];

      for (const img of imageUrls) {
        try {
          const headers: Record<string, string> = {};
          if (img.url.includes("slack")) {
            const slackToken = process.env.SLACK_BOT_TOKEN;
            if (slackToken) {
              headers["Authorization"] = `Bearer ${slackToken}`;
            }
          }

          const imgRes = await fetch(img.url, { headers });
          if (imgRes.ok) {
            const buffer = await imgRes.arrayBuffer();
            const base64 = Buffer.from(buffer).toString("base64");
            const mediaType =
              img.mimeType ||
              imgRes.headers.get("content-type") ||
              "image/png";
            contentParts.push({
              type: "image",
              source: {
                type: "base64",
                media_type: mediaType,
                data: base64,
              },
            });
          }
        } catch {
          // Skip failed image downloads silently
        }
      }

      if (contentParts.length > 0) {
        contentParts.push({ type: "text", text: question });
        userContent = contentParts;
      }
    }

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.SMART_MODEL || "claude-sonnet-4-20250514",
        max_tokens: 500,
        stream: true,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
      }),
    });

    if (!res.ok) {
      log.warn("API error", { status: res.status });
      return null;
    }

    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let fullOutput = "";
    let buffer = "";

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;
          try {
            const event = JSON.parse(data);
            if (event.type === "content_block_delta" && event.delta?.text) {
              fullOutput += event.delta.text;
              onChunk(event.delta.text);
            }
          } catch {
            /* skip malformed JSON */
          }
        }
      }
    }

    return fullOutput || null;
  } catch (err) {
    log.error("Streaming error", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
