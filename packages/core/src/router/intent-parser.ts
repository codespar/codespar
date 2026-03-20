/**
 * Intent Parser — Regex-based classification with Claude Haiku NLU fallback.
 * Parses @codespar commands into structured intents.
 *
 * Strategy: regex first (fast, free), NLU only when regex returns "unknown".
 */

import type { ParsedIntent, IntentType } from "../types/intent.js";
import { INTENT_RISK } from "../types/intent.js";
import { parseWithNLU } from "./nlu-parser.js";

interface PatternRule {
  type: IntentType;
  pattern: RegExp;
  paramExtractor?: (match: RegExpMatchArray) => Record<string, string>;
}

const PATTERNS: PatternRule[] = [
  {
    type: "status",
    pattern: /^status(?:\s+(build|agent|all))?$/i,
    paramExtractor: (m) => ({ target: m[1] || "all" }),
  },
  {
    type: "help",
    pattern: /^help$/i,
  },
  {
    type: "logs",
    pattern: /^logs(?:\s+(\d+))?$/i,
    paramExtractor: (m) => ({ count: m[1] || "10" }),
  },
  {
    type: "instruct",
    pattern: /^instruct\s+(.+)$/i,
    paramExtractor: (m) => ({ instruction: m[1] }),
  },
  {
    type: "fix",
    pattern: /^fix\s+(.+)$/i,
    paramExtractor: (m) => ({ issue: m[1] }),
  },
  {
    type: "deploy",
    pattern: /^deploy(?:\s+(staging|production|prod))?$/i,
    paramExtractor: (m) => ({ environment: m[1] || "staging" }),
  },
  {
    type: "rollback",
    pattern: /^rollback(?:\s+(staging|production|prod))?$/i,
    paramExtractor: (m) => ({ environment: m[1] || "staging" }),
  },
  {
    type: "approve",
    pattern: /^approve(?:\s+(\S+))?$/i,
    paramExtractor: (m) => ({ token: m[1] || "" }),
  },
  {
    type: "autonomy",
    pattern: /^autonomy\s+[Ll]?(\d)$/i,
    paramExtractor: (m) => ({ level: m[1] }),
  },
  {
    type: "review",
    pattern: /^review(?:\s+PR\s*#?\s*(\d+))?$/i,
    paramExtractor: (m) => ({ prNumber: m[1] || "" }),
  },
  {
    type: "context",
    pattern: /^(?:context|memory)$/i,
  },
  {
    type: "link",
    pattern: /^link\s+(https?:\/\/\S+|[\w-]+\/[\w.-]+)$/i,
    paramExtractor: (m) => ({ repo: m[1] }),
  },
  {
    type: "unlink",
    pattern: /^unlink$/i,
  },
  {
    type: "kill",
    pattern: /^kill$/i,
  },
  {
    type: "whoami",
    pattern: /^whoami$/i,
  },
  {
    type: "register",
    pattern: /^register\s+(.+)$/i,
    paramExtractor: (m) => ({ name: m[1] }),
  },
  {
    type: "prs",
    pattern: /^(?:prs?|pull.?requests?|open.?prs?)(?:\s+(open|closed|all))?$/i,
    paramExtractor: (m) => ({ state: m[1] || "open" }),
  },
];

/** Synchronous regex-only parser (used internally). */
function parseIntentRegex(text: string): ParsedIntent {
  const trimmed = text.trim();

  for (const rule of PATTERNS) {
    const match = trimmed.match(rule.pattern);
    if (match) {
      return {
        type: rule.type,
        risk: INTENT_RISK[rule.type],
        params: rule.paramExtractor ? rule.paramExtractor(match) : {},
        rawText: trimmed,
        confidence: 1.0,
      };
    }
  }

  return {
    type: "unknown",
    risk: "low",
    params: {},
    rawText: trimmed,
    confidence: 0,
  };
}

/**
 * Parse user text into a structured intent.
 * Tries regex first (fast, no API call). Falls back to Claude Haiku NLU
 * when regex returns "unknown" and ANTHROPIC_API_KEY is available.
 */
export async function parseIntent(text: string): Promise<ParsedIntent> {
  // Try regex first (fast, no API call)
  const regexResult = parseIntentRegex(text);

  // If regex matched a known intent, use it
  if (regexResult.type !== "unknown") {
    return regexResult;
  }

  // Fall back to NLU for natural language
  const nluResult = await parseWithNLU(text);
  if (nluResult && nluResult.type !== "unknown") {
    return nluResult;
  }

  // Nothing matched
  return regexResult;
}
