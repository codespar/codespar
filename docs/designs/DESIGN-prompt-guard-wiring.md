---
status: Accepted
problem: |
  PromptGuard is fully implemented (12 pattern rules, structural analysis,
  composite risk scoring, configurable threshold) and well-tested (26 unit
  tests), but promptGuard.analyze() is never called in any runtime code path.
  An agent platform accepting natural-language commands from public messaging
  channels has no injection screening.
decision: |
  Wire PromptGuard selectively into MessageRouter.route(), screening only
  LLM-bound intents (instruct, fix, plan, spec, lens, unknown). Block at
  autonomy L3+; log-only at L0-L2. Audit all triggers regardless of action.
  Configurable threshold via PROMPT_GUARD_THRESHOLD env var.
rationale: |
  Full-path enforcement (every message, every intent) produces false positives
  on legitimate developer commands and guards structured intents where user
  text never reaches an LLM. Selective enforcement targets the actual risk
  surface while autonomy-gated blocking avoids disrupting human-supervised
  workflows. The guard adds defense-in-depth value against low-sophistication
  attacks and provides security audit intelligence, even though it cannot stop
  determined attackers who use paraphrasing or encoding to bypass regex.
---

# DESIGN: Wire Prompt Injection Guard into Runtime

## Status

Proposed

## Context and Problem Statement

CodeSpar accepts natural-language commands from WhatsApp, Slack, Telegram,
Discord, and a web chat interface. Each inbound message flows through either
`MessageRouter.route()` (channel adapters via `AgentSupervisor`) or the
`/api/chat` HTTP routes (web dashboard) before reaching an agent. Both paths
converge on `MessageRouter.route()` -- the web chat's `chatHandler` is wired
as `router.route(message, orgId)` in `server/start.mjs:296`.

`PromptGuard` exists in `packages/core/src/security/prompt-guard.ts` with
12 regex-based pattern rules (injection overrides, jailbreaks, data
exfiltration, command injection, delimiter attacks), structural analysis
(role markers, instruction-heavy language, Unicode homoglyphs), and composite
risk scoring with a configurable block threshold (default 0.7). It has 26
passing unit tests.

Despite being exported from `@codespar/core`, `promptGuard.analyze()` is
never invoked outside the test file. Every user message reaches agents
unscreened.

### Threat model

The attack surface is narrow: only authenticated channel users (those with
access to the messaging workspace) can reach agents. Messages require @mention
or DM. RBAC prevents unauthorized actions. Execution sandboxing (Docker)
restricts what agents can do. Claude's own safety training is the primary
defense against prompt manipulation.

PromptGuard's regex-based approach cannot stop sophisticated attacks
(paraphrasing, encoding, multi-turn buildup, indirect injection). It catches
low-sophistication attempts -- copy-paste jailbreaks, "ignore previous
instructions" patterns, known DAN-mode prompts -- and provides audit
visibility into who is attempting what.

### Which intents expose user text to an LLM?

Not all intents pass user-authored free text to Claude. Structured commands
(`status`, `deploy`, `approve`, `logs`, etc.) parse parameters from the
message and never forward raw text to an LLM. Only these intents are
LLM-bound:

| Intent | LLM path | Notes |
|--------|----------|-------|
| `instruct` | ClaudeBridge (Sonnet) | User instruction becomes the task prompt |
| `fix` | ClaudeBridge (Sonnet) | Error description forwarded to Claude |
| `plan` | PlanningAgent (Sonnet) | Feature description sent to Claude |
| `spec` | Claude Sonnet | Free-form spec request |
| `lens` | LensAgent (Sonnet) | Natural language query sent to Claude for SQL generation |
| `unknown` | SmartResponder (Sonnet) | Entire message forwarded as open-ended question |

Running the guard on structured intents (`status`, `deploy`, `rollback`,
`approve`, `logs`, `link`, `autonomy`, `kill`, etc.) adds false positive
risk with zero security benefit.

## Decision Drivers

- **Security** -- this is defense layer #7 of 10; it exists to raise the cost
  of low-sophistication attacks and provide audit visibility
- **False positive cost** -- blocking legitimate developer commands (e.g.,
  "instruct add a system prompt template") is actively harmful; at least 6 of
  12 patterns can trigger on common developer language
- **Observability** -- knowing that someone tried "DAN mode" in your workspace
  has security intelligence value, even when the attack would fail downstream
- **Autonomy awareness** -- at L0-L2, a human reviews every action, making
  pre-screening less critical; at L3+, agents act without review, making
  pre-screening more valuable
- **Configurability** -- operators need to tune the threshold for their
  context or disable it entirely
- **Testability** -- the wiring must be verifiable end-to-end

## Considered Options

### Decision 0: Is wiring PromptGuard actually needed?

The negative thesis: given RBAC, execution sandboxing, and Claude's safety
training, is regex-based input screening useful or just security theater?

Key assumptions:
- Claude's safety training is the primary defense against prompt injection
- Authenticated users (not anonymous internet traffic) are the threat model
- False positives are more damaging than false negatives in a developer tool

#### Chosen: Implement selectively

Wire PromptGuard only for LLM-bound intents, with autonomy-gated behavior.
At L0-L2 (human in the loop), log triggers but don't block. At L3+ (no
human review), block messages above the threshold.

This approach captures the real value of PromptGuard (audit intelligence,
low-sophistication attack filtering on exposed paths) while avoiding the
primary risk (false positives on legitimate developer commands routed to
structured handlers that never touch an LLM).

#### Alternatives considered

**A. Wire into all runtime paths (every message, every intent):**
Rejected because structured commands (`status`, `deploy`, etc.) never forward
user text to an LLM. Running the guard on these adds false positive risk
(developer saying "add a system prompt template" gets blocked) with zero
security benefit. At least 6 of 12 patterns produce false positives on
common developer language.

**B. Don't implement (deprecate PromptGuard):**
Rejected because it loses audit visibility (knowing who attempts injection is
valuable security intelligence) and removes a defense-in-depth layer against
low-sophistication attacks. The "10 defense layers" claim in the security spec
matters for enterprise trust. The code is already written and tested -- wiring
cost is low.

### Decision 1: Guard placement and audit wiring

Where in the code does the guard run, and how are blocked/flagged messages
recorded?

Key assumptions:
- Both ingress paths (channel adapters and web chat) converge on
  `router.route()`
- PromptGuard.analyze() is synchronous and sub-millisecond
- Audit logging is best-effort (failures don't prevent blocking)

#### Chosen: Guard in MessageRouter.route(), add optional StorageProvider

Place the guard inside `MessageRouter.route()` after intent parsing and
agent resolution, but before `agent.handleMessage()`. Add an optional
`StorageProvider` parameter to the MessageRouter constructor for audit
logging.

This is the only placement where the guard is impossible to bypass -- every
message through `route()` is screened. The `StorageProvider` dependency
follows the existing pattern of the optional `IdentityResolver` for RBAC.
When storage is absent, the guard still blocks; it just skips audit writes.

Since `chatHandler` is wired as `router.route()`, this single placement
covers both channel adapter messages and web chat messages. No separate
guard call is needed in the HTTP routes.

#### Alternatives considered

**B. Guard at caller level (router returns rejection, caller audits):**
Rejected because every caller must remember to audit blocked responses.
The "blocked" response is indistinguishable from a normal ChannelResponse
unless we add a flag. Two callers today, but more could appear.

**C. Guard as a middleware/wrapper function:**
Rejected because wrapping must happen at every call site to `router.route()`.
If a new call site is added, it must remember to wrap. The wrapping pattern
is uncommon in this codebase -- existing patterns use setter injection
(`setChatHandler`, `setAlertHandler`), not functional wrappers.

**D. Guard in MessageRouter with callback (no storage dependency):**
Rejected because if the callback is never wired, blocked messages are
silently unaudited with no signal. An optional `StorageProvider` makes the
dependency visible in the constructor signature.

### Decision 2: Testing strategy

What test layers and specific test cases verify the wiring?

Key assumptions:
- PromptGuard detection accuracy is already covered by 26 existing unit tests
- The `ServerContext` stub pattern from `a2a.test.ts` is the established way
  to test routes
- Audit logging is tested via `vi.fn()` mock storage, not Testcontainers

#### Chosen: Focused integration testing (20 tests, 2 files)

Test the real PromptGuard (no mocking of the guard itself) at each
integration point. Verify wiring, blocking, logging, and autonomy-gated
behavior. See the full test plan in the Testing section below.

#### Alternatives considered

**A. Comprehensive multi-layer testing (25-35 tests):**
Rejected because unit tests with mocked PromptGuard duplicate what the 26
existing tests already cover. Testing that we call a function is less
valuable than testing that the function actually blocks injections in
context. The real guard is pure regex with no I/O -- no performance reason
to mock it.

**C. Contract testing approach:**
Rejected because in practice this is Option B with extra ceremony. The
"contract" is already defined by PromptGuard's API.

## Decision Outcome

The three decisions compose as follows:

1. **D0 (selective enforcement)** determines *when* the guard runs: only
   for LLM-bound intents, with behavior gated on autonomy level
2. **D1 (placement in MessageRouter)** determines *where*: inside
   `route()` after intent parsing and agent resolution, before dispatch
3. **D2 (testing strategy)** determines *how we verify*: focused
   integration tests with real PromptGuard, no mocking of the guard

Cross-validation resolved one conflict: D1 originally placed the guard
before intent parsing, but D0's selective approach requires the intent type
to decide whether to guard. The guard now runs after `parseIntent()` and
agent resolution but before `agent.handleMessage()`.

The execution order in `MessageRouter.route()` becomes:

```
1. isMentioningBot / isDM filter          (existing)
2. parseIntent(message.text)              (existing)
3. RBAC check                             (existing)
4. Multi-project routing / find agent     (existing)
5. PromptGuard check                      (NEW — only LLM-bound intents)
6. agent.handleMessage(message, intent)   (existing)
```

## Solution Architecture

### Overview

PromptGuard is wired into `MessageRouter.route()` as a check between agent
resolution (step 4) and agent dispatch (step 6). It screens only LLM-bound
intents and its behavior depends on the resolved agent's autonomy level.

### Components modified

| Component | File | Change |
|-----------|------|--------|
| `MessageRouter` | `packages/core/src/router/message-router.ts` | Add optional `StorageProvider`, add guard check after agent resolution |
| `PromptGuard` | `packages/core/src/security/prompt-guard.ts` | Add `PROMPT_GUARD_THRESHOLD` env var support to default instance |
| Intent types | `packages/core/src/types/intent.ts` | Add `LLM_BOUND_INTENTS` set |
| Server bootstrap | `packages/channels/cli/src/index.ts` (or `server/start.mjs`) | Pass storage to MessageRouter constructor |

No new packages, no new dependencies, no API surface changes.

### Key interfaces

**New constant in `intent.ts`:**

```typescript
/** Intents that forward user text to an LLM. Only these are screened by PromptGuard. */
export const LLM_BOUND_INTENTS: ReadonlySet<IntentType> = new Set([
  "instruct", "fix", "plan", "spec", "lens", "unknown",
]);
```

**New constant for autonomy blocking threshold:**

```typescript
/** Minimum autonomy level at which PromptGuard blocks (vs. log-only). */
export const PROMPT_GUARD_BLOCK_AUTONOMY: AutonomyLevel = 3;
```

**Updated MessageRouter constructor:**

```typescript
constructor(
  identityResolver?: IdentityResolver,
  storage?: StorageProvider,
  guard?: PromptGuard,       // defaults to module-level singleton
) {
  this.identityResolver = identityResolver ?? null;
  this.storage = storage ?? null;
  this.guard = guard ?? promptGuard;
}
```

**Central dispatch method (replaces direct `handleMessage()` calls):**

The current `route()` has 4 dispatch points that call `agent.handleMessage()`
directly: coordinator path, alias match (bare and with subcommand), and
single-project path. A guard inserted at one point misses the others.

The fix: extract a private `guardAndDispatch()` method. All 4 dispatch
sites call this instead of `handleMessage()` directly.

```typescript
private async guardAndDispatch(
  agent: Agent,
  message: NormalizedMessage,
  intent: ParsedIntent,
): Promise<ChannelResponse | null> {
  // --- Prompt guard (LLM-bound intents only) ---
  if (LLM_BOUND_INTENTS.has(intent.type)) {
    const analysis = this.guard.analyze(message.text);

    if (analysis.triggers.length > 0) {
      await this.auditPromptGuard(message, analysis, intent, agent);
    }

    if (analysis.blocked && agent.config.autonomyLevel >= PROMPT_GUARD_BLOCK_AUTONOMY) {
      return {
        text: "[codespar] Message blocked by security policy.",
      };
    }
  }

  return agent.handleMessage(message, intent);
}
```

Then in `route()`, each dispatch call changes from:
```typescript
return coordinator.handleMessage(message, intent);
// becomes:
return this.guardAndDispatch(coordinator, message, intent);
```

**Audit helper (private method on MessageRouter):**

```typescript
private async auditPromptGuard(
  message: NormalizedMessage,
  analysis: PromptAnalysis,
  intent: ParsedIntent,
  agent: Agent,
): Promise<void> {
  if (!this.storage) return;
  try {
    await this.storage.appendAudit({
      actorType: "user",
      actorId: message.channelUserId,
      action: analysis.blocked ? "prompt_guard.blocked" : "prompt_guard.flagged",
      result: analysis.blocked ? "denied" : "success",
      metadata: {
        riskScore: analysis.riskScore,
        triggers: analysis.triggers,
        intent: intent.type,
        autonomyLevel: agent.config.autonomyLevel,
        channel: message.channelType,
        textPreview: message.text.slice(0, 100),
      },
    });
  } catch {
    // Audit logging is best-effort
  }
}
```

Note: `AuditEntry.result` uses `"denied"` for blocked messages and
`"success"` for flagged-but-passed messages, matching the existing type
union (`"success" | "failure" | "denied" | "pending" | "approved" | "error"`).

### Data flow

```
Channel SDK event
  |
  v
ChannelAdapter.onMessage()
  |
  v
NormalizedMessage --> AgentSupervisor --> MessageRouter.route()
                                           |
                                           +--> 1. isMentioningBot/isDM filter
                                           +--> 2. parseIntent()
                                           +--> 3. RBAC check
                                           +--> 4. Find agent (multi-project routing)
                                           +--> 5. guardAndDispatch(agent, message, intent) [NEW]
                                                  |
                                                  +--> LLM-bound intent?
                                                  |      No  --> agent.handleMessage()
                                                  |      Yes --> analyze(text)
                                                  |               |
                                                  |               +--> triggers? --> audit
                                                  |               +--> blocked + L3+? --> reject
                                                  |               +--> else --> agent.handleMessage()
```

All 4 dispatch paths in `route()` (coordinator, alias match, bare alias,
single project) call `guardAndDispatch()` instead of `handleMessage()`
directly. This prevents bypass regardless of which routing branch is taken.

Web chat (`/api/chat`, `/api/chat/stream`) flows through the same path
because `chatHandler` is wired as `router.route()`. No separate guard
call is needed in the HTTP routes.

### Threshold configuration

The `PROMPT_GUARD_THRESHOLD` env var is read once at startup and passed to
the `PromptGuard` constructor. The value is clamped to `[0, 1]` to prevent
misconfiguration (negative values would block everything, values > 1 would
block nothing silently).

```typescript
// In prompt-guard.ts
const envThreshold = parseFloat(process.env.PROMPT_GUARD_THRESHOLD || "");
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

export const promptGuard = new PromptGuard(
  Number.isFinite(envThreshold) ? clamp(envThreshold, 0, 1) : BLOCK_THRESHOLD
);
```

Setting `PROMPT_GUARD_THRESHOLD=1.0` effectively disables blocking while
preserving audit logging (no message scores exactly 1.0).

### Known gaps (out of scope)

**A2A routes:** `POST /a2a/tasks` accepts `input.text` from external agents
and does not go through `MessageRouter.route()`. This is an unguarded ingress
path. It belongs to S7 ("extend prompt injection guard to indirect sources"),
not this design. Note: A2A execution is not yet wired (tasks are stored but
not dispatched), so this is theoretical today.

**Indirect injection:** CI logs, PR bodies, commit messages, and pasted code
content are not screened. Also S7's scope.

**Image attachments:** `NormalizedMessage` supports image attachments that
reach Claude via `ClaudeBridge.buildUserContent()`. An attacker could embed
injection instructions in an image (OCR-based indirect injection). The guard
only screens `message.text`. Claude's own safety training is the defense for
image content. Also S7's scope.

## Implementation Approach

### Phase 1: Core wiring

Add `LLM_BOUND_INTENTS` to `intent.ts`. Update `MessageRouter` constructor
to accept optional `StorageProvider`. Add the guard check in `route()` after
agent resolution. Update the default `promptGuard` singleton to read
`PROMPT_GUARD_THRESHOLD` from the environment.

Deliverables:
- `packages/core/src/types/intent.ts` -- add `LLM_BOUND_INTENTS`
- `packages/core/src/router/message-router.ts` -- add storage param, guard check
- `packages/core/src/security/prompt-guard.ts` -- env var support on singleton

### Phase 2: Bootstrap wiring

Pass storage to MessageRouter in the server bootstrap code. Verify the guard
is active by checking logs with a test injection.

Deliverables:
- `packages/channels/cli/src/index.ts` or `server/start.mjs` -- pass storage
  to router constructor

### Phase 3: Tests

Write the full test suite (see Testing section below).

Deliverables:
- `packages/core/src/router/__tests__/message-router-guard.test.ts`
- `packages/core/src/server/routes/__tests__/chat-guard.test.ts`

### Phase 4: Documentation

Update the prompt guard docs page to reflect the runtime wiring, selective
enforcement, and autonomy-gated behavior.

Deliverables:
- `apps/docs/content/docs/guides/prompt-guard.mdx`

## Testing

### Philosophy

The 26 existing PromptGuard unit tests cover detection accuracy. The wiring
tests verify one thing: **the guard is in the path, and blocking, passing,
logging, and autonomy-gating work correctly at each integration point.**

No mocking of PromptGuard itself -- the guard is pure regex with no I/O.
Testing with the real guard verifies that the wiring actually blocks
injections, not just that a function was called.

### Test file locations

```
packages/core/src/router/__tests__/message-router-guard.test.ts
packages/core/src/server/routes/__tests__/chat-guard.test.ts
```

### MessageRouter guard tests (13 tests)

File: `message-router-guard.test.ts`

Setup: Real `MessageRouter` with a real `PromptGuard`. Mock agent with
configurable autonomy level. Mock `StorageProvider` with `vi.fn()` on
`appendAudit`.

#### Wiring (4 tests)

| # | Test | Verifies |
|---|------|----------|
| 1 | Safe message with LLM-bound intent (`instruct`) routes to agent normally | Guard does not interfere with normal flow |
| 2 | Known injection ("ignore previous instructions") with `instruct` intent at L3 returns blocked response | Guard blocks before agent dispatch |
| 3 | Blocked response text is generic ("security policy"), does not leak trigger names | Security: no information leakage to attacker |
| 4 | Agent's `handleMessage` is never called when message is blocked | Guard short-circuits before agent |

#### Selective enforcement (3 tests)

| # | Test | Verifies |
|---|------|----------|
| 5 | Known injection with `status` intent routes to agent normally | Guard skips non-LLM-bound intents |
| 6 | Known injection with `deploy` intent routes to agent normally | Guard skips structured commands even at high risk level |
| 7 | Known injection with `unknown` intent at L3 is blocked | SmartResponder path (most exposed) is guarded |

#### Autonomy gating (3 tests)

| # | Test | Verifies |
|---|------|----------|
| 8 | Known injection at autonomy L2 (Suggest) routes to agent | Human in the loop -- log only, don't block |
| 9 | Known injection at autonomy L3 (Auto-Low) is blocked | No human review -- block |
| 10 | Known injection at autonomy L0 (Passive) routes to agent | Lowest autonomy -- definitely don't block |

#### Audit trail (3 tests)

| # | Test | Verifies |
|---|------|----------|
| 11 | Blocked message writes audit entry with action `prompt_guard.blocked` | Audit captures blocks |
| 12 | Flagged-but-not-blocked message (L2 + injection) writes audit with `prompt_guard.flagged` | Audit captures flags at low autonomy |
| 13 | Safe message with no triggers does not write audit entry | No noise in audit trail |

### Chat route guard tests (4 tests)

File: `chat-guard.test.ts`

Setup: Lightweight Fastify instance (same pattern as `a2a.test.ts`). Stub
`ServerContext` with mock storage. Real PromptGuard. Since `chatHandler` is
wired as `router.route()`, these tests verify the HTTP-level behavior -- the
guard logic itself is tested at the router level.

| # | Test | Verifies |
|---|------|----------|
| 14 | POST /api/chat with safe message returns normal response | Guard does not interfere |
| 15 | POST /api/chat with injection attempt returns blocked response | Guard blocks via router, HTTP returns the rejection |
| 16 | POST /api/chat/stream with safe message streams progress + response | SSE flow unaffected |
| 17 | POST /api/chat/stream with injection sends error event and closes | SSE-appropriate error handling |

### Threshold configuration tests (3 tests)

In `message-router-guard.test.ts`:

| # | Test | Verifies |
|---|------|----------|
| 18 | PromptGuard with threshold 0.5 blocks medium-risk messages that default wouldn't | Custom threshold respected |
| 19 | PromptGuard with threshold 0.99 allows most injections through | High threshold effectively disables guard |
| 20 | Default threshold (0.7) matches expected behavior | Sanity check for production default |

### Total: 20 tests across 2 files

### What we deliberately skip

- **Re-testing detection patterns:** the 26 existing tests cover this
- **Mocking PromptGuard:** testing with a mock only verifies a function was
  called; testing with the real guard verifies actual blocking behavior
- **Load testing:** the guard is pure CPU (regex), sub-millisecond
- **Testcontainers:** audit trail is tested via mock storage, not a real database
- **Cross-channel variation:** the guard only sees text; channel type is
  irrelevant to guard behavior

## Security Considerations

This design IS a security feature. Key considerations:

### Limitations operators must understand

PromptGuard is a low-sophistication filter, not a comprehensive injection
defense. It catches copy-paste jailbreak attempts and known attack patterns.
It does not catch:
- Paraphrased injection ("please set aside your earlier guidelines")
- Encoded payloads (base64, ROT13, Unicode substitution beyond homoglyphs)
- Multi-turn buildup attacks (stateless -- sees one message at a time)
- Indirect injection via pasted code, URLs, or file content
- Semantic attacks ("write a function called ignore_previous_instructions")

Documentation must be honest about these limitations. Operators who rely
solely on PromptGuard for injection defense have a false sense of security.

### Defense in depth positioning

PromptGuard is one layer in a 10-layer defense model. The actual primary
defenses against prompt injection are:
1. RBAC (prevents unauthorized actions regardless of message content)
2. Execution sandboxing (Docker restricts what agents can do)
3. Claude's safety training (rejects harmful instructions at the LLM level)
4. `blockedPatterns` in ClaudeBridge (prevents dangerous tool usage)

PromptGuard adds value by raising the cost of attack from "copy paste from
Reddit" to "think about paraphrasing" and by providing audit visibility into
injection attempts.

### Audit value

All PromptGuard triggers are audit-logged regardless of whether the message
is blocked. This gives operators visibility into:
- Who is attempting injection (user identity via channel mapping)
- What patterns are being tried (triggers list)
- Whether the guard is producing false positives (flagged legitimate commands)

This audit data can inform threshold tuning and pattern refinement.

### False positive mitigation

Autonomy-gated behavior (log-only at L0-L2, block at L3+) is the primary
false positive mitigation. At low autonomy, a human reviews every action --
false positives would block legitimate work with no security benefit. At
high autonomy, the tradeoff favors caution because no human reviews the
agent's actions.

The `PROMPT_GUARD_THRESHOLD` env var allows operators to tune sensitivity.
Setting it to 1.0 effectively disables blocking while preserving audit
logging.

### Information leakage in blocked responses

Blocked responses use a generic message (`"Message blocked by security
policy."`) rather than revealing which patterns triggered or the risk score.
Exposing trigger names would help attackers iteratively refine payloads to
avoid detection. The specific triggers and scores are recorded only in the
audit trail, where operators can inspect them.

### Audit text preview and secret exposure

The `textPreview` audit field stores the first 100 characters of flagged
messages. A developer might accidentally paste secrets in a command (e.g.,
"instruct fix the auth bug where GITHUB_TOKEN=ghp_..."). This is consistent
with the existing `chat.ts` audit pattern which already stores
`text.slice(0, 100)`. If the codebase adds secret redaction to Pino logging
in the future, the same redaction should be applied to audit text previews.

## Consequences

### Positive

- PromptGuard is activated after existing as dead code -- defense layer #7
  becomes real
- Audit trail captures injection attempts, providing security intelligence
  even when attacks would fail downstream
- Selective enforcement avoids false positives on structured commands
- Autonomy-gated behavior respects the human-in-the-loop at low autonomy
  levels
- Minimal code change -- the guard logic already exists and is well-tested

### Negative

- MessageRouter gains a StorageProvider dependency, expanding its
  responsibility surface
- The guard's behavior now depends on intent type AND autonomy level, adding
  conditional complexity to the routing path
- Regex-based detection remains fundamentally bypassable by sophisticated
  attackers -- this is a limitation of the approach, not something this
  design can fix
- A2A routes remain unguarded (out of scope, deferred to S7)

### Mitigations

- StorageProvider is optional, following the existing IdentityResolver pattern
- The `LLM_BOUND_INTENTS` set is a clear, documented constant -- adding new
  LLM-bound intents requires consciously adding them to the set
- Honest documentation about PromptGuard's limitations prevents false
  confidence
- S7 is already planned to address indirect sources including A2A routes
