# Architecture Review: DESIGN-prompt-guard-wiring

Status: Proposed
Reviewer: Architecture agent
Date: 2026-04-07

---

## Q1: Is the architecture clear enough to implement from this document alone?

**Verdict: Yes, with two clarifications needed.**

The design doc is unusually well-structured. The execution order diagram (steps 1-6), the code snippets for the guard check and audit helper, the `LLM_BOUND_INTENTS` constant, and the test plan with 20 numbered test cases are all sufficient for an implementer to work from without ambiguity.

Two items need clarification before implementation:

1. **Multi-project routing bypass.** The current `MessageRouter.route()` has four distinct dispatch paths: (a) `all` prefix to coordinator, (b) alias match with sub-command, (c) single project agent, (d) multiple projects with no alias. The design shows the guard at step 5 "after agent resolution, before dispatch," but the code has agent resolution interleaved with dispatch -- `agentByAlias.handleMessage()` is called inline at lines 81-91, not after a single resolution step. The implementer needs to know: does the guard run once before the four-way branch, or must it be inserted before each `handleMessage()` call? The design implies a single insertion point, but the code structure requires the guard at 3-4 points.

2. **Audit entry `intent` field.** The audit helper in the design hardcodes `intent: "unknown"` with a comment "filled by caller." This is incomplete -- the `auditPromptGuard` method needs the `ParsedIntent` passed in, or the comment should be removed and `intent.type` used directly. An implementer would have to make this decision themselves.

## Q2: Are there missing components or interfaces?

**One missing, one misaligned.**

**Missing: `PromptGuard` injection into `MessageRouter`.** The design says the guard runs inside `route()` but does not specify how the `PromptGuard` instance reaches the router. Two options exist in the codebase: (a) import the module-level singleton `promptGuard` directly, or (b) accept it as a constructor parameter. The design leans toward the singleton (the env var section modifies the default export), but never states this explicitly. Given that `StorageProvider` is passed via constructor, consistency argues for passing the guard the same way. The design should pick one.

**Misaligned: `AuditEntry.result` type.** The audit helper uses `result: "allowed"` for flagged-but-not-blocked messages. The `AuditEntry` interface at `storage/types.ts:22` defines result as `"success" | "failure" | "denied" | "pending" | "approved" | "error"`. The value `"allowed"` is not in the union. Implementation will fail type checking. Use `"success"` instead, or extend the union type.

## Q3: Are the implementation phases correctly sequenced?

**Yes. The four phases are correctly ordered.**

Phase 1 (core wiring) must come first because Phase 2 (bootstrap) depends on the new constructor signature, and Phase 3 (tests) depends on the wired behavior. Phase 4 (docs) is correctly last.

One minor concern: Phase 2 mentions `server/start.mjs` but this is a JavaScript file that would need to pass a `StorageProvider` that already exists in the bootstrap context. The design should confirm which bootstrap file(s) need modification -- the CLI entry point (`packages/channels/cli/src/index.ts`) creates the router today, and the server bootstrap (`packages/core/src/server/start.mjs` or equivalent) is a separate path. Both need the storage injected.

## Q4: Are there simpler alternatives we overlooked?

**One worth noting, already partially addressed.**

The simplest alternative is a decorator/wrapper approach: a `guardedRoute()` function that wraps `router.route()`. The design explicitly rejected this (Decision 1, Option C) for the right reason -- new call sites can forget to wrap. However, the rejection overstates the risk: there are exactly two call sites today and the codebase is small. If the multi-project routing bypass issue (Q1) makes the in-router approach messy (guard logic repeated 3-4 times inside `route()`), the wrapper approach becomes simpler despite the theoretical bypass risk.

No other simpler alternatives exist. The selective enforcement by intent type is already the simplest viable approach -- full-path enforcement would be simpler to implement but worse in practice (false positives).

## Q5: Does the guard check position introduce race conditions or edge cases?

**No race conditions. Two edge cases.**

Race conditions are not a concern because `route()` is `async` but processes a single message sequentially. There is no shared mutable state between the guard check and the dispatch.

Edge cases:

1. **Coordinator bypass.** When `firstWord === "all"`, the message routes to the coordinator at line 70 without ever reaching the guard check position (step 5 in the design). If the coordinator forwards user text to an LLM (e.g., `all instruct fix the tests`), the injection goes unscreened. The design should specify whether the guard runs before the coordinator dispatch or whether the coordinator is responsible for its own screening.

2. **Re-parsed intent on alias match.** When an alias matches (lines 77-91), the intent is re-parsed from `subText` (the message minus the alias). The guard should use this re-parsed intent, not the original `intent` from line 44. If the implementer places the guard before the alias branch using the original intent, the wrong intent type is checked. For example, `myproject instruct hack the system` would have the original intent as "unknown" (because "myproject" is the first word, confusing the parser), but the sub-intent is "instruct."

## Q6: Is the `LLM_BOUND_INTENTS` set correct?

**Mostly correct. Two intents worth reviewing.**

The proposed set: `instruct`, `fix`, `plan`, `spec`, `lens`, `unknown`.

Intents that forward user text to an LLM per the codebase:
- `instruct` -- yes, user text becomes the task prompt via ClaudeBridge
- `fix` -- yes, error description forwarded to Claude
- `plan` -- yes, feature description sent to PlanningAgent -> Claude
- `spec` -- yes, free-form spec request to Claude
- `lens` -- yes, natural language query to Claude for SQL generation
- `unknown` -- yes, entire message to SmartResponder -> Claude Sonnet

**Candidates to review:**

- **`review`**: The ReviewAgent analyzes PR diffs via Claude. However, the user text for `review PR #123` is structured (just a PR number), not free-form text forwarded to Claude. The PR content itself is fetched from GitHub. Correct to exclude.
- **`scan`/`perf`/`docs`**: These accept structured parameters (`debt|security|quality|all`, `report|bundle|latency|all`, `generate|changelog|api|architecture`). If any of them forward the parameter to Claude as a prompt, they should be included. Based on the regex patterns in `intent-parser.ts`, these take enumerated values, not free text. Correct to exclude.

**The set is correct as proposed.** The only risk is future intents that forward free text but are not added to the set. The design already calls this out in the mitigations section ("adding new LLM-bound intents requires consciously adding them to the set").

## Q7: Does the autonomy level comparison handle the type correctly?

**The comparison works but should use the type-safe enum value.**

`AutonomyLevel` is defined as `0 | 1 | 2 | 3 | 4 | 5` (a numeric literal union type). The design uses `agent.config.autonomyLevel >= 3`. This comparison is valid TypeScript -- numeric literal unions support `>=` comparisons. TypeScript will not produce a type error.

However, using a magic number `3` obscures the semantic boundary. The codebase defines autonomy levels with labels (L0=Passive through L5=Full Auto). The design should define a named constant:

```typescript
/** Minimum autonomy level at which PromptGuard blocks (rather than logs). */
const PROMPT_GUARD_BLOCK_AUTONOMY: AutonomyLevel = 3;
```

This makes the threshold self-documenting and allows the comparison to read as `agent.config.autonomyLevel >= PROMPT_GUARD_BLOCK_AUTONOMY`. It also ensures the threshold is an `AutonomyLevel` value (not accidentally set to 7, for example).

---

## Summary of findings

| # | Severity | Finding |
|---|----------|---------|
| 1 | High | Multi-project routing: guard must be inserted at 3-4 dispatch points, not one. Coordinator and alias paths bypass the proposed single insertion point. |
| 2 | High | `AuditEntry.result: "allowed"` is not in the type union. Will fail `tsc --strict`. Use `"success"` or extend the type. |
| 3 | Medium | Audit helper hardcodes `intent: "unknown"` -- should accept `ParsedIntent` and use `intent.type`. |
| 4 | Medium | How `PromptGuard` instance reaches `MessageRouter` is unspecified -- singleton import vs. constructor injection. |
| 5 | Low | Autonomy threshold `>= 3` should be a named constant for self-documentation. |
| 6 | Low | Phase 2 should enumerate all bootstrap files that create a `MessageRouter` (CLI entry + server bootstrap). |

## Recommendation

The design is solid and well-reasoned. The two high-severity findings (routing bypass and type mismatch) are implementation blockers that should be resolved in the design before coding starts. The medium-severity items can be resolved during implementation. Approve after addressing findings #1 and #2.
