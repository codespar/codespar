/**
 * Smart Responder — Uses Claude Sonnet to generate intelligent responses
 * for open-ended questions that don't match any specific command.
 *
 * Provides the LLM with agent context (status, project, memory, audit)
 * so it can give informed, relevant answers.
 */

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
        messages: [{ role: "user", content: question }],
      }),
    });

    if (!res.ok) {
      console.log("[smart] API error:", res.status);
      return null;
    }

    const data = (await res.json()) as {
      content?: Array<{ text?: string }>;
    };
    return data.content?.[0]?.text || null;
  } catch (err) {
    console.log("[smart] Error:", err);
    return null;
  }
}
