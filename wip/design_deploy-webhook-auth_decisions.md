# Auto-mode decisions: deploy-webhook-auth

## D1: Verification pattern

**Decision point:** How should the deploy handler verify signatures?

**Choice:** Reuse the exact Sentry/Vercel verification block — org storage lookup, env var fallback, enforceWebhookSecret(), verifyWebhookSignature().

**Rationale:** The pattern is proven, DRY, and already reviewed in S2. No reason to diverge.

**Alternatives dismissed:**
- Custom verification logic: violates DRY, duplicates webhook-auth.ts
- Middleware-level verification: webhook handlers need org-scoped secret resolution which happens inside the route, not before it

## D2: Signature header name

**Decision point:** What header should callers use?

**Choice:** `x-deploy-signature` (decided in PRD).

**Rationale:** Follows the `x-<provider>-signature` convention (x-vercel-signature, sentry-hook-signature). A distinct header avoids confusion with API auth (Authorization: Bearer).

## D3: Algorithm

**Decision point:** SHA-256 or SHA-1?

**Choice:** SHA-256.

**Rationale:** Matches GitHub and Sentry. Vercel uses SHA-1 for legacy reasons (their API predates widespread SHA-256 adoption). New endpoints should use the stronger algorithm.
