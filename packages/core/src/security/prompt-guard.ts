/**
 * Prompt Injection Guard — Defense Layer #7
 *
 * Detects and blocks prompt injection attempts before they reach the LLM.
 * Uses a multi-layer approach:
 *
 * 1. Pattern blocklist — known injection patterns (regex)
 * 2. Structure analysis — detects role/system prompt manipulation
 * 3. Risk scoring — composite score from multiple signals
 *
 * Usage:
 *   const result = promptGuard.analyze("ignore previous instructions...");
 *   if (result.blocked) {
 *     // reject the message
 *   }
 */

import { createLogger } from "../observability/logger.js";

const log = createLogger("prompt-guard");

export interface PromptAnalysis {
  /** Whether the message should be blocked */
  blocked: boolean;
  /** Risk score 0-1 (0 = safe, 1 = definitely injection) */
  riskScore: number;
  /** Which rules triggered */
  triggers: string[];
  /** Human-readable reason for blocking */
  reason?: string;
}

/** Pattern rule definition */
interface PatternRule {
  id: string;
  pattern: RegExp;
  weight: number; // 0-1, contribution to risk score
  description: string;
}

/** Threshold above which a message is blocked */
const BLOCK_THRESHOLD = 0.7;

/** Known prompt injection patterns */
const INJECTION_PATTERNS: PatternRule[] = [
  // Direct instruction override
  {
    id: "ignore-previous",
    pattern: /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?|context)/i,
    weight: 0.9,
    description: "Attempts to override previous instructions",
  },
  {
    id: "new-instructions",
    pattern: /(?:new|updated|revised|real)\s+instructions?\s*:/i,
    weight: 0.85,
    description: "Tries to inject new instruction set",
  },
  {
    id: "you-are-now",
    pattern: /you\s+are\s+now\s+(?:a|an|the)\s+/i,
    weight: 0.8,
    description: "Attempts to redefine assistant identity",
  },
  {
    id: "system-prompt",
    pattern: /(?:system\s*prompt|system\s*message|<<\s*SYS|<\|system\|>|\[INST\])/i,
    weight: 0.9,
    description: "Tries to inject system-level prompt markers",
  },
  {
    id: "forget-everything",
    pattern: /forget\s+(?:everything|all|what)\s+(?:you|i)\s+(?:know|said|told)/i,
    weight: 0.85,
    description: "Attempts to reset context",
  },

  // Role manipulation
  {
    id: "act-as",
    pattern: /(?:act|behave|pretend|respond)\s+as\s+(?:if\s+you\s+(?:are|were)|a\s+(?:different|new))/i,
    weight: 0.7,
    description: "Role manipulation attempt",
  },
  {
    id: "jailbreak",
    pattern: /(?:DAN|do\s+anything\s+now|jailbreak|unrestricted\s+mode|developer\s+mode)/i,
    weight: 0.95,
    description: "Known jailbreak technique",
  },

  // Data exfiltration
  {
    id: "reveal-prompt",
    pattern: /(?:reveal|show|print|output|repeat|display)\s+(?:your|the|system)\s+(?:prompt|instructions|rules)/i,
    weight: 0.8,
    description: "Attempts to extract system prompt",
  },
  {
    id: "leak-secrets",
    pattern: /(?:what\s+(?:is|are)\s+your|show\s+me\s+(?:the|your))\s+(?:api\s*key|secret|token|password|credential)/i,
    weight: 0.9,
    description: "Attempts to extract secrets",
  },

  // Encoding evasion
  {
    id: "base64-injection",
    pattern: /(?:decode|eval|execute)\s+(?:this\s+)?(?:base64|b64|hex)/i,
    weight: 0.75,
    description: "Encoded payload injection",
  },

  // Command injection via agent tools
  {
    id: "dangerous-commands",
    pattern: /(?:rm\s+-rf|DROP\s+TABLE|DELETE\s+FROM|format\s+c:|shutdown|reboot|curl\s+.*\|.*sh)/i,
    weight: 0.95,
    description: "Dangerous command injection",
  },
  {
    id: "file-access",
    pattern: /(?:cat|read|open|access)\s+(?:\/etc\/passwd|\.env|credentials|\.ssh|private\s*key)/i,
    weight: 0.9,
    description: "Sensitive file access attempt",
  },

  // Delimiter injection
  {
    id: "delimiter-break",
    pattern: /(?:```\s*(?:system|assistant|user)|<\/?(?:system|instruction|prompt)>|={3,}(?:SYSTEM|END|BEGIN))/i,
    weight: 0.8,
    description: "Delimiter/format injection",
  },
];

/**
 * Structural analysis — detects suspicious message structures
 * that don't match specific patterns but have injection characteristics.
 */
function analyzeStructure(text: string): { score: number; triggers: string[] } {
  const triggers: string[] = [];
  let score = 0;

  // Excessive use of role markers
  const roleMarkers = (text.match(/\b(?:assistant|system|user|human|AI)\s*:/gi) || []).length;
  if (roleMarkers >= 2) {
    score += 0.3;
    triggers.push("multiple-role-markers");
  }

  // Very long messages with instruction-like language
  const instructionWords = (text.match(/\b(?:must|always|never|override|bypass|instead|disregard)\b/gi) || []).length;
  if (instructionWords >= 3) {
    score += 0.2;
    triggers.push("instruction-heavy-language");
  }

  // Markdown/format abuse (many headers, code blocks suggesting prompt structure)
  const headers = (text.match(/^#{1,3}\s/gm) || []).length;
  const codeBlocks = (text.match(/```/g) || []).length;
  if (headers >= 5 || codeBlocks >= 6) {
    score += 0.15;
    triggers.push("excessive-formatting");
  }

  // Unicode homoglyph detection (zero-width chars, RTL overrides)
  const suspiciousUnicode = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;
  if (suspiciousUnicode.test(text)) {
    score += 0.4;
    triggers.push("suspicious-unicode");
  }

  return { score: Math.min(score, 1), triggers };
}

export class PromptGuard {
  private customPatterns: PatternRule[] = [];
  private blockThreshold: number;

  constructor(blockThreshold: number = BLOCK_THRESHOLD) {
    this.blockThreshold = blockThreshold;
  }

  /** Add a custom pattern rule */
  addPattern(rule: PatternRule): void {
    this.customPatterns.push(rule);
  }

  /** Analyze a message for prompt injection risk */
  analyze(text: string): PromptAnalysis {
    if (!text || text.trim().length === 0) {
      return { blocked: false, riskScore: 0, triggers: [] };
    }

    const allPatterns = [...INJECTION_PATTERNS, ...this.customPatterns];
    const triggers: string[] = [];
    let maxPatternWeight = 0;

    // Check all patterns
    for (const rule of allPatterns) {
      if (rule.pattern.test(text)) {
        triggers.push(rule.id);
        maxPatternWeight = Math.max(maxPatternWeight, rule.weight);
      }
    }

    // Structural analysis
    const structure = analyzeStructure(text);
    triggers.push(...structure.triggers);

    // Composite risk score: max pattern weight + structural bonus
    const riskScore = Math.min(
      maxPatternWeight + structure.score * 0.3,
      1,
    );

    const blocked = riskScore >= this.blockThreshold;

    if (blocked) {
      log.warn("Prompt injection blocked", {
        riskScore: riskScore.toFixed(2),
        triggers,
        textPreview: text.slice(0, 100),
      });
    } else if (triggers.length > 0) {
      log.debug("Prompt risk detected (below threshold)", {
        riskScore: riskScore.toFixed(2),
        triggers,
      });
    }

    return {
      blocked,
      riskScore,
      triggers,
      reason: blocked
        ? `Blocked: ${triggers.join(", ")} (risk: ${(riskScore * 100).toFixed(0)}%)`
        : undefined,
    };
  }
}

/** Default singleton instance — reads PROMPT_GUARD_THRESHOLD from environment */
const envThreshold = parseFloat(process.env.PROMPT_GUARD_THRESHOLD || "");
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

export const promptGuard = new PromptGuard(
  Number.isFinite(envThreshold) ? clamp(envThreshold, 0, 1) : BLOCK_THRESHOLD,
);
