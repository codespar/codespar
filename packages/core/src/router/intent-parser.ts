/**
 * Intent Parser v0 — Regex-based classification.
 * Parses @codespar commands into structured intents.
 *
 * v1 will add Claude Haiku NLU for natural language understanding.
 */

import type { ParsedIntent, IntentType } from "../types/intent.js";
import { INTENT_RISK } from "../types/intent.js";

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
    type: "kill",
    pattern: /^kill$/i,
  },
];

export function parseIntent(text: string): ParsedIntent {
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
