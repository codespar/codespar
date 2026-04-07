# Decision: Test Plan for Prompt Guard Wiring

## Question

What test layers, categories, and infrastructure are needed to verify the prompt guard wiring end-to-end?

## Alternatives Considered

### A. Comprehensive multi-layer testing (25-35 tests)

Separate unit tests with mocked PromptGuard at each integration point, integration tests with real PromptGuard, plus edge case and regression layers.

**Pros:** Maximum isolation; easy to pinpoint failures.
**Cons:** Heavy mocking duplicates what the real guard already tests. The 26 existing unit tests already cover detection accuracy -- re-testing pattern matching through mocks adds little. Maintenance cost grows with every new integration point.

### B. Focused integration testing only (10-15 tests)

Test the real wiring with real PromptGuard at each entry point. No mocking of the guard itself.

**Pros:** Tests what actually matters -- that the guard is called, blocks correctly, and audit entries are written. Low maintenance.
**Cons:** If a test fails, you need to check whether the guard's detection broke or the wiring broke. Acceptable tradeoff since the guard has its own 26 tests for detection accuracy.

### C. Contract testing approach (12-18 tests)

Define a "guard contract" (injection blocked, safe passes) and verify it at each integration point.

**Pros:** Clear behavioral contracts.
**Cons:** In practice, this is just Option B with extra ceremony. The "contract" is already defined by PromptGuard's API.

## Recommendation: Option B -- Focused Integration Testing

The guard's detection logic is already well-tested (26 tests). The wiring tests should verify one thing: **the guard is in the path, and blocking/passing/auditing work correctly at each integration point.** No mocking of PromptGuard -- test the real thing.

### Test File Locations

```
packages/core/src/router/__tests__/message-router-guard.test.ts   (MessageRouter)
packages/core/src/server/routes/__tests__/chat-guard.test.ts      (chat routes)
```

### Test Cases: MessageRouter (7 tests)

File: `packages/core/src/router/__tests__/message-router-guard.test.ts`

**Setup:** Real `MessageRouter` with a real `PromptGuard` instance. Mock agent registered. No need for Testcontainers -- the router doesn't touch the database.

| # | Test | Verifies |
|---|------|----------|
| 1 | Safe message routes to agent normally | Guard does not interfere with normal flow |
| 2 | Known injection ("ignore previous instructions") returns blocked response | Guard blocks before agent dispatch |
| 3 | Blocked response text includes a user-facing reason | UX: user understands why their message was rejected |
| 4 | Agent's `handleMessage` is never called when blocked | Guard short-circuits before agent |
| 5 | Message below threshold but with triggers still routes | Guard allows borderline messages |
| 6 | Empty message does not trigger guard error | Edge case: empty text after @mention removal |
| 7 | Non-bot message (isDM=false, isMentioningBot=false) skips guard entirely | Guard should not run on messages the router already ignores |

### Test Cases: Chat Routes (7 tests)

File: `packages/core/src/server/routes/__tests__/chat-guard.test.ts`

**Setup:** Lightweight Fastify instance (same pattern as `a2a.test.ts`). Stub `ServerContext` with a mock `StorageProvider` that captures `appendAudit` calls. Real PromptGuard.

**POST /api/chat:**

| # | Test | Verifies |
|---|------|----------|
| 8 | Safe message returns normal chat response | Guard does not interfere |
| 9 | Injection attempt returns 403 with blocked reason | Guard blocks at HTTP layer with appropriate status code |
| 10 | Blocked message writes audit entry with action `prompt_guard.blocked` | Audit trail captures blocks |
| 11 | Blocked message never calls `chatHandler` | Guard short-circuits before agent dispatch |

**POST /api/chat/stream:**

| # | Test | Verifies |
|---|------|----------|
| 12 | Safe message streams progress + response events | Guard does not interfere with SSE flow |
| 13 | Injection attempt sends error event and closes stream | Guard blocks with SSE-appropriate error format |
| 14 | Blocked stream message writes audit entry | Audit trail for streaming path |

### Test Cases: Configuration (3 tests)

These belong in the MessageRouter test file since threshold config affects routing behavior.

| # | Test | Verifies |
|---|------|----------|
| 15 | Custom threshold via constructor: 0.5 blocks medium-risk messages | Threshold is respected |
| 16 | Custom threshold via constructor: 0.99 allows most injections | High threshold effectively disables guard |
| 17 | Default threshold (0.7) matches production behavior | Sanity check for the default |

**Total: 17 tests across 2 files.**

### How to Test Audit Trail Without a Real Database

The `ServerContext` stub (established pattern from `a2a.test.ts`) includes a mock `StorageProvider`. The mock's `appendAudit` is a `vi.fn()` that captures calls. Tests assert:

```typescript
expect(mockStorage.appendAudit).toHaveBeenCalledWith(
  expect.objectContaining({
    action: "prompt_guard.blocked",
    actorType: "user",
    metadata: expect.objectContaining({
      riskScore: expect.any(Number),
      triggers: expect.any(Array),
    }),
  })
);
```

No Testcontainers needed. The `a2a.test.ts` file already proves this stub pattern works.

### How to Test Env Var Configuration

The `PROMPT_GUARD_THRESHOLD` env var should be read once at startup and passed to the `PromptGuard` constructor. Tests use the constructor directly with explicit threshold values (tests 15-17) rather than manipulating `process.env`, which avoids test pollution and is more reliable. One optional test can verify the env var parsing logic in the server bootstrap, but that's a startup concern, not a guard concern.

### Edge Cases That Matter Most

1. **Empty message after @mention stripping** -- the router strips the mention, leaving empty text. Guard must not throw.
2. **Threshold boundary** -- a message scoring exactly 0.7 should be blocked (>= threshold). Test with a known injection that scores near the boundary.
3. **Guard disabled** -- if threshold is set to 1.0+, nothing should block. This ensures operators can disable the guard in development.
4. **SSE error format** -- blocked messages on the stream endpoint must send a proper SSE error event and close the stream, not leave it hanging.

### What We Deliberately Skip

- **Re-testing detection patterns:** The 26 existing tests in `prompt-guard.test.ts` cover this. Wiring tests use one known-good injection and one known-safe message as fixtures.
- **Mocking PromptGuard:** Testing with a mock guard only verifies that we call a function. Testing with the real guard verifies that the wiring actually blocks injections. The real guard is fast (pure regex, no I/O), so there's no performance reason to mock it.
- **Load/stress testing:** Not appropriate for unit/integration tests. Guard is pure CPU (regex), so performance is predictable.
- **Cross-channel identity interaction:** The guard runs before identity resolution. It only sees text. Channel type is irrelevant to guard behavior.

## Confidence

**High (0.9).** The codebase has clear test patterns (`a2a.test.ts` for route testing, `prompt-guard.test.ts` for guard unit testing). The recommended plan follows both patterns. The only uncertainty is the exact HTTP status code for blocked chat requests (403 vs. 400) -- that's a design choice, not a testing question.

## Key Assumptions

1. `PromptGuard` remains a synchronous, pure-function class with no I/O dependencies. If it gains async behavior (e.g., calling an external classifier), the test approach stays the same but tests become async.
2. The `ServerContext` stub pattern from `a2a.test.ts` is the established way to test routes. No need for a different approach.
3. Audit logging for blocked messages is best-effort (same as existing chat audit logging). Tests verify the call is made, not that it persists to a database.
4. The guard runs at the same integration points for all channel types -- channel adapters feed into `MessageRouter.route()`, so testing the router covers all channels.
