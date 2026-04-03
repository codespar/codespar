/**
 * Smart Responder — Uses Claude Sonnet to generate intelligent responses
 * for open-ended questions that don't match any specific command.
 *
 * Provides the LLM with agent context (status, project, memory, audit)
 * so it can give informed, relevant answers.
 */

import { createLogger } from "../observability/logger.js";

const log = createLogger("smart");

export interface DeployRecord {
  id: string;
  project: string;
  state: string;
  commitSha: string;
  commitMessage: string;
  author: string;
  branch: string;
  buildTimeS: number;
  timestamp: string;
  url?: string;
  error?: string;
}

export interface AgentContext {
  agentId: string;
  projectId: string;
  repoUrl?: string;
  autonomyLevel: number;
  tasksHandled: number;
  uptimeMinutes: number;
  recentAudit: Array<{ action: string; detail: string; timestamp: string; repo?: string; branch?: string; commitSha?: string; commitMessage?: string }>;
  recentCommits?: Array<{ sha: string; message: string; author: string; date: string }>;
  recentDeploys?: DeployRecord[];
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

Recent activity (last 30 events):
${context.recentAudit.slice(0, 30).map((a) => {
  const extra = [a.repo, a.branch, a.commitSha?.slice(0, 7), a.commitMessage].filter(Boolean).join(" | ");
  return `- ${a.action}: ${a.detail}${extra ? ` [${extra}]` : ""}`;
}).join("\n") || "No recent activity"}

Recent Git commits (from GitHub API):
${context.recentCommits?.slice(0, 20).map((c) => `- ${c.sha} ${c.message} (by ${c.author}, ${c.date})`).join("\n") || "No commits available"}

Recent deployments (from Vercel):
${context.recentDeploys?.slice(0, 15).map((d) => `- [${d.state}] ${d.project} commit ${d.commitSha?.slice(0, 7)} "${d.commitMessage?.slice(0, 60)}" by ${d.author} (${d.branch}, ${d.buildTimeS}s, ${d.timestamp})${d.error ? ` ERROR: ${d.error}` : ""}`).join("\n") || "No deployment data available"}

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

CRITICAL RULES:
1. ONLY use information from the context above. NEVER invent files, errors, or fixes that aren't in the data.
2. If asked to investigate a deploy, report what the audit data shows — don't propose code changes.
3. If a deploy was successful, say "Deploy succeeded" clearly. Don't look for problems that don't exist.
4. Keep responses under 800 words. Use bullet points. Be direct and factual.
5. Answer in the same language the user writes in.
6. When asked for release notes or changes: include ALL relevant events, grouped by commit/deploy.
7. If you don't have enough data to answer, say so — don't guess.`;

  try {
    // Build message content with images if present
    let userContent: string | Array<Record<string, unknown>> = question;

    if (imageUrls && imageUrls.length > 0) {
      const contentParts: Array<Record<string, unknown>> = [];

      for (const img of imageUrls) {
        try {
          const headers: Record<string, string> = {};
          if (img.url.includes("slack") || img.url.includes("files.slack.com")) {
            const slackToken = process.env.SLACK_BOT_TOKEN;
            if (slackToken) {
              headers["Authorization"] = `Bearer ${slackToken}`;
            }
          }

          const imgRes = await fetch(img.url, { headers, redirect: "follow" });
          if (!imgRes.ok) continue;

          const buffer = await imgRes.arrayBuffer();
          if (buffer.byteLength > 4 * 1024 * 1024) continue;

          const base64 = Buffer.from(buffer).toString("base64");
          let rawType = img.mimeType || imgRes.headers.get("content-type") || "image/png";
          rawType = rawType.split(";")[0].trim().toLowerCase();
          const allowedTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
          const mediaType = allowedTypes.includes(rawType) ? rawType : "image/png";

          contentParts.push({
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType,
              data: base64,
            },
          });
        } catch {
          // Skip failed image downloads
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
        max_tokens: 2000,
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

Recent activity (last 30 events):
${context.recentAudit.slice(0, 30).map((a) => {
  const extra = [a.repo, a.branch, a.commitSha?.slice(0, 7), a.commitMessage].filter(Boolean).join(" | ");
  return `- ${a.action}: ${a.detail}${extra ? ` [${extra}]` : ""}`;
}).join("\n") || "No recent activity"}

Recent Git commits (from GitHub API):
${context.recentCommits?.slice(0, 20).map((c) => `- ${c.sha} ${c.message} (by ${c.author}, ${c.date})`).join("\n") || "No commits available"}

Recent deployments (from Vercel):
${context.recentDeploys?.slice(0, 15).map((d) => `- [${d.state}] ${d.project} commit ${d.commitSha?.slice(0, 7)} "${d.commitMessage?.slice(0, 60)}" by ${d.author} (${d.branch}, ${d.buildTimeS}s, ${d.timestamp})${d.error ? ` ERROR: ${d.error}` : ""}`).join("\n") || "No deployment data available"}

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

CRITICAL RULES:
1. ONLY use information from the context above. NEVER invent files, errors, or fixes that aren't in the data.
2. If asked to investigate a deploy, report what the audit data shows — don't propose code changes.
3. If a deploy was successful, say "Deploy succeeded" clearly. Don't look for problems that don't exist.
4. Keep responses under 800 words. Use bullet points. Be direct and factual.
5. Answer in the same language the user writes in.
6. When asked for release notes or changes: include ALL relevant events, grouped by commit/deploy.
7. If you don't have enough data to answer, say so — don't guess.`;

  try {
    // Build message content with images if present
    let userContent: string | Array<Record<string, unknown>> = question;

    if (imageUrls && imageUrls.length > 0) {
      const contentParts: Array<Record<string, unknown>> = [];

      for (const img of imageUrls) {
        try {
          const headers: Record<string, string> = {};
          if (img.url.includes("slack") || img.url.includes("files.slack.com")) {
            const slackToken = process.env.SLACK_BOT_TOKEN;
            if (slackToken) {
              headers["Authorization"] = `Bearer ${slackToken}`;
            }
          }

          const imgRes = await fetch(img.url, { headers, redirect: "follow" });
          if (!imgRes.ok) continue;

          const buffer = await imgRes.arrayBuffer();
          if (buffer.byteLength > 4 * 1024 * 1024) continue;

          const base64 = Buffer.from(buffer).toString("base64");
          let rawType = img.mimeType || imgRes.headers.get("content-type") || "image/png";
          rawType = rawType.split(";")[0].trim().toLowerCase();
          const allowedTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
          const mediaType = allowedTypes.includes(rawType) ? rawType : "image/png";

          contentParts.push({
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType,
              data: base64,
            },
          });
        } catch {
          // Skip failed image downloads
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
        max_tokens: 2000,
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
