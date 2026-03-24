/**
 * Smart Alert Analyzer — Uses Claude to analyze deploy failures
 * and generate root cause analysis with fix suggestions.
 */

import { createLogger } from "../observability/logger.js";
import { metrics } from "../observability/metrics.js";
import type { DeployAlert } from "../server/webhook-server.js";

const log = createLogger("smart-alert");

export interface SmartAlertResult {
  rootCause: string;
  affectedFiles: string[];
  suggestedFix: string;
  severity: "low" | "medium" | "high" | "critical";
  confidence: "low" | "medium" | "high";
  rawAlert: DeployAlert;
}

export async function analyzeDeployFailure(alert: DeployAlert): Promise<SmartAlertResult | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    log.warn("No ANTHROPIC_API_KEY — skipping smart alert analysis");
    return null;
  }

  const model = process.env.NLU_MODEL || "claude-haiku-4-5-20251001";
  const prompt = `You are a DevOps expert analyzing a deploy failure.

Project: ${alert.project}
Branch: ${alert.branch}
Commit: ${alert.commitSha} by ${alert.commitAuthor}
Commit message: ${alert.commitMessage}
Error: ${alert.errorMessage}
Repository: ${alert.repo}

Analyze this deploy failure and respond in JSON:
{
  "rootCause": "Brief root cause (1-2 sentences)",
  "affectedFiles": ["list of likely affected files based on error"],
  "suggestedFix": "Concrete fix suggestion (2-3 sentences)",
  "severity": "low|medium|high|critical",
  "confidence": "low|medium|high"
}

Only output valid JSON, nothing else.`;

  try {
    const start = Date.now();
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const durationMs = Date.now() - start;
    metrics.increment("api.claude.calls");
    metrics.observe("api.claude.latency_ms", durationMs);

    if (!res.ok) {
      log.error("Smart alert API error", { status: res.status });
      return null;
    }

    const data = await res.json() as { content?: Array<{ text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
    const text = data.content?.[0]?.text || "";

    // Track tokens
    const inputTokens = data.usage?.input_tokens ?? 0;
    const outputTokens = data.usage?.output_tokens ?? 0;
    metrics.observe("api.claude.tokens_in", inputTokens);
    metrics.observe("api.claude.tokens_out", outputTokens);

    // Parse JSON response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log.warn("Smart alert: no JSON in response");
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]);
    log.info("Smart alert analysis complete", {
      project: alert.project,
      severity: parsed.severity,
      durationMs,
    });

    return {
      rootCause: parsed.rootCause || "Unknown",
      affectedFiles: parsed.affectedFiles || [],
      suggestedFix: parsed.suggestedFix || "Manual investigation required",
      severity: parsed.severity || "medium",
      confidence: parsed.confidence || "low",
      rawAlert: alert,
    };
  } catch (err) {
    log.error("Smart alert analysis failed", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Format a smart alert result as a rich text message for channels */
export function formatSmartAlert(analysis: SmartAlertResult): string {
  const alert = analysis.rawAlert;
  const severityEmoji = { low: "\u26a0\ufe0f", medium: "\ud83d\udd36", high: "\ud83d\udd34", critical: "\ud83d\udea8" }[analysis.severity] || "\u26a0\ufe0f";

  return [
    `${severityEmoji} **Deploy Failure Analysis** — ${alert.project}`,
    ``,
    `**Branch:** ${alert.branch}`,
    `**Commit:** ${alert.commitSha} by ${alert.commitAuthor}`,
    alert.commitMessage ? `**Message:** ${alert.commitMessage.slice(0, 100)}` : "",
    ``,
    `**Root Cause:** ${analysis.rootCause}`,
    analysis.affectedFiles.length > 0 ? `**Affected Files:** ${analysis.affectedFiles.join(", ")}` : "",
    `**Suggested Fix:** ${analysis.suggestedFix}`,
    ``,
    `_Severity: ${analysis.severity} \u00b7 Confidence: ${analysis.confidence}_`,
    alert.inspectorUrl ? `Build logs: ${alert.inspectorUrl}` : "",
    ``,
    `Reply with \`fix investigate-deploy\` for deep analysis or \`fix auto-heal\` to apply the suggested fix.`,
  ].filter(Boolean).join("\n");
}
