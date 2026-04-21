## Visibility

Public

## Topic

oss-contract-test — Implement issue #95: add OSS contract-test leg for @codespar/types

## Starting Point

Issue: https://github.com/codespar/codespar/issues/95
Design: codespar-web/docs/designs/DESIGN-f4-m1-session-contract.md
Plan: codespar-web/docs/plans/PLAN-f4-m1-session-contract.md
Reference PR: codespar/codespar-core#7 (merged 2026-04-21)

## Leads (Research Round 1)

- What does the contract suite test? → Read @codespar/types/src/testing/contract-suite.ts
- Where is WebhookServer and what does it expose? → packages/core/src/server/webhook-server.ts
- Does the OSS runtime have /v1/sessions routes? → No routes found
- Is @codespar/types published to npm? → No (v0.3.0 tag not yet created on codespar-core)
- What is the CI workflow? → .github/workflows/ci.yml (build-and-test + security jobs)
