---
status: Proposed
problem: |
  PromptGuard is fully implemented (12 pattern rules, structural analysis,
  composite risk scoring, configurable threshold) and well-tested (26 unit
  tests), but promptGuard.analyze() is never called in any runtime code path.
  An agent platform accepting natural-language commands from public messaging
  channels has no injection screening.
decision: |
  TBD
rationale: |
  TBD
---

# DESIGN: Wire Prompt Injection Guard into Runtime

## Status

Proposed

## Context and Problem Statement

CodeSpar accepts natural-language commands from WhatsApp, Slack, Telegram,
Discord, and a web chat interface. Each inbound message flows through either
`MessageRouter.route()` (channel adapters) or the `/api/chat` HTTP routes
(web dashboard) before reaching an agent.

`PromptGuard` exists in `packages/core/src/security/prompt-guard.ts` with
12 regex-based pattern rules (injection overrides, jailbreaks, data
exfiltration, command injection, delimiter attacks), structural analysis
(role markers, instruction-heavy language, Unicode homoglyphs), and composite
risk scoring with a configurable block threshold (default 0.7). It has 26
passing unit tests.

Despite being exported from `@codespar/core`, `promptGuard.analyze()` is
never invoked outside the test file. Every user message reaches agents
unscreened.

## Decision Drivers

- Security is the primary driver -- this is defense layer #7 of 10
- Minimal disruption -- the guard already works, we're wiring it in
- Observability -- blocked messages must be auditable
- Configurability -- operators need to tune the threshold for their context
- Testability -- the wiring must be verifiable end-to-end, not just unit-tested
- Performance -- guard runs on every message; must not add perceptible latency
