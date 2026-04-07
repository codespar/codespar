# Decision: Where does promptGuard.analyze() run?

## Question

Where does `promptGuard.analyze()` run in the CodeSpar runtime, and how do blocked messages get recorded in the audit trail?

## Critical Context

Both message ingress paths converge on a single call: `MessageRouter.route()`.

- **Channel adapters** go through `AgentSupervisor`, which calls `this.router.route(message, orgId)` (supervisor.ts:104).
- **Web chat** routes (`/api/chat`, `/api/chat/stream`) call `ctx.chatHandler(message, orgId)`, which is wired in `start.mjs:296` as `router.route(message, orgId)`.

This convergence is the most important architectural fact for this decision.

## Alternatives Considered

### A. Guard in MessageRouter, add StorageProvider dependency

Add `storage?: StorageProvider` to MessageRouter constructor. Call `promptGuard.analyze()` before `parseIntent()` in `route()`. If blocked, audit via storage, return rejection response. Chat routes also add guard before chatHandler call.

- **Pro:** Single enforcement point -- every message through `route()` is guarded. Guard runs before intent parsing (correct order).
- **Pro:** Impossible to bypass -- no caller can forget to add the check.
- **Con:** MessageRouter gains a `StorageProvider` dependency. Currently it only depends on `IdentityResolver` (auth). Adding storage expands its responsibility surface.
- **Con:** Audit logging in chat routes for blocked messages would be duplicated (chat routes already audit after chatHandler returns).

### B. Guard at caller level -- MessageRouter returns rejection, caller audits

MessageRouter calls `promptGuard.analyze()` and returns a special "blocked" ChannelResponse. The caller (supervisor or server bootstrap) handles audit logging. Chat routes handle their own guard + audit.

- **Pro:** MessageRouter stays storage-free.
- **Con:** Callers must remember to audit blocked responses. Two callers today (supervisor, chatHandler lambda), but more could appear.
- **Con:** The "blocked" response is indistinguishable from a normal ChannelResponse unless we add a flag or convention. Fragile.

### C. Guard as a middleware/wrapper function

Create a `withPromptGuard(routeFn, storage?)` wrapper that wraps both `router.route()` and `chatHandler`. Handles guard check + audit in one place.

- **Pro:** Single implementation, no changes to MessageRouter internals.
- **Pro:** Clean separation -- prompt guarding is a cross-cutting concern and a wrapper reflects that.
- **Con:** Adds indirection. The wrapping must happen at two sites: supervisor's `onMessage` callback and `start.mjs`'s `setChatHandler`. If someone adds a third call site to `router.route()`, they must remember to wrap it too.
- **Con:** Wrapping pattern is uncommon in this codebase. The existing pattern is setter-based (`setChatHandler`, `setAlertHandler`), not functional wrappers.

### D. Guard in MessageRouter (no storage), audit via event/callback

MessageRouter gets an `onBlocked?: (message, analysis) => void` callback. Guard runs in router, callback handles audit externally. Chat routes handle guard independently.

- **Pro:** MessageRouter stays storage-free but still enforces the guard for all `route()` callers.
- **Pro:** Callback pattern is already used in the codebase (`setChatHandler`, `setAlertHandler`, `onProgress` in NormalizedMessage metadata).
- **Con:** Split responsibility -- guard enforcement is in the router, but audit recording is wherever the callback is wired. Slightly harder to trace.
- **Con:** Chat routes still need their own guard call (they don't go through `route()` directly -- they go through `chatHandler`, which happens to call `route()`, but the guard should run before that lambda, not inside it). Wait -- actually they do: `chatHandler` IS `router.route()`. So the guard in `route()` covers chat routes too.

## Recommendation: Option A -- Guard in MessageRouter, add StorageProvider dependency

**Confidence: High (85%)**

The convergence of both ingress paths on `router.route()` makes this the only option where the guard is impossible to bypass. That property matters more than keeping MessageRouter's dependency list minimal.

The dependency concern is real but manageable:

1. `StorageProvider` is already optional (`storage?: StorageProvider`). When absent, the guard still blocks -- it just skips audit logging, same as how RBAC works today when `identityResolver` is absent.
2. MessageRouter already takes an optional `IdentityResolver` for auth. Adding an optional `StorageProvider` for security audit follows the same pattern. Both are security-adjacent concerns that belong at the routing boundary.
3. The alternative (Option D's callback) achieves similar decoupling but creates a subtle failure mode: if the callback is never wired, blocked messages are silently unaudited with no signal. An optional `StorageProvider` at least makes the dependency visible in the constructor signature.

The guard should run as the first check in `route()`, before even the `isMentioningBot`/`isDM` filter. Injection attempts in non-mention messages should still be detected and logged, even if the message would otherwise be ignored. (This is debatable -- reasonable to put it after the mention check to reduce noise. Flag for implementation.)

Chat route duplication is a non-issue: since `chatHandler` is wired as `router.route()`, the guard in `route()` covers both `/api/chat` and `/api/chat/stream` automatically. No separate guard call needed in chat routes.

## Key Assumptions

1. **Both ingress paths will continue to converge on `router.route()`.** If a future path bypasses the router (e.g., a direct agent call from an A2A protocol endpoint), it would also bypass the guard. The A2A routes should be checked -- if they call agents directly, they need their own guard.
2. **PromptGuard.analyze() is fast.** It runs regex patterns synchronously. No concern about adding latency to the hot path.
3. **Audit logging for blocked messages is best-effort.** Failures to audit should not prevent the block from taking effect. The guard blocks first, audits second.
4. **The optional StorageProvider pattern is acceptable.** It follows the existing `IdentityResolver` precedent in MessageRouter.
