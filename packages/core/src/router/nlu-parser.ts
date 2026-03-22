/**
 * NLU Parser — Uses Claude Haiku for natural language intent classification.
 * Falls back gracefully if ANTHROPIC_API_KEY is not set.
 */

import type { ParsedIntent, IntentType } from "../types/intent.js";
import { INTENT_RISK } from "../types/intent.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("nlu");

const SYSTEM_PROMPT = `You are an intent classifier for CodeSpar, an AI agent platform.
Classify the user's message into ONE of these intents:

- status: asking about build status, agent status, project health
- help: asking for help or available commands
- instruct: asking the agent to do a coding task (add feature, refactor, etc.)
- fix: asking to fix a bug, error, or failing test
- review: asking to review a PR or code changes
- deploy: asking to deploy to an environment
- rollback: asking to rollback a deployment
- approve: approving a pending action
- autonomy: changing the agent's autonomy level
- logs: asking to see activity or audit logs
- link: linking a repository
- unlink: unlinking a repository
- context: asking about agent memory, context, or learned patterns
- prs: asking about pull requests (how many PRs, list PRs, open PRs)
- merge: asking to merge a pull request
- plan: asking to plan or break down a large feature into sub-tasks
- unknown: cannot determine intent

Respond with ONLY a JSON object: {"intent":"<type>","params":{},"confidence":0.95}

For instruct/fix/plan, extract the task description into params.instruction or params.issue.
For deploy/rollback, extract environment into params.environment.
For review, extract PR number into params.prNumber.
For autonomy, extract level into params.level.`;

export async function parseWithNLU(
  text: string,
): Promise<ParsedIntent | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    log.debug("No ANTHROPIC_API_KEY set, skipping NLU");
    return null;
  }

  log.debug("Classifying", { text });

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.NLU_MODEL || "claude-haiku-4-5-20251001",
        max_tokens: 200,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: text }],
      }),
    });

    if (!res.ok) {
      log.warn("API error", { status: res.status });
      return null;
    }

    const data = (await res.json()) as {
      content?: Array<{ text?: string }>;
    };
    let content = data.content?.[0]?.text;
    if (!content) return null;

    // Strip markdown code fences if present (Haiku sometimes wraps in ```json```)
    content = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

    const parsed = JSON.parse(content) as {
      intent: string;
      params?: Record<string, string>;
      confidence?: number;
    };
    const intentType = parsed.intent as IntentType;

    // Validate that the intent is a known type
    if (!(intentType in INTENT_RISK)) return null;

    const result = {
      type: intentType,
      risk: INTENT_RISK[intentType] ?? "low",
      params: parsed.params ?? {},
      rawText: text,
      confidence: parsed.confidence ?? 0.8,
    };
    log.info("Classified", { text, intent: intentType, confidence: result.confidence });
    return result;
  } catch (err) {
    log.error("Parse error", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
