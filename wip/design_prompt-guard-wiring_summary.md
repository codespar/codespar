# Design Summary: prompt-guard-wiring

## Input Context (Phase 0)
**Source:** Freeform topic (S1 from OSS v1 roadmap)
**Problem:** PromptGuard.analyze() is never called in runtime. All user messages reach agents unscreened.
**Constraints:** Public repo, preserve existing 26 tests, audit blocked messages, configurable threshold.

## Decisions (Phase 2-3)
- D0: Implement selectively (LLM-bound intents only, autonomy-gated)
- D1: Guard in MessageRouter.route() with optional StorageProvider
- D2: 20 focused integration tests across 2 files
- Cross-validation: resolved D0/D1 ordering conflict (guard runs after parseIntent)

## Current Status
**Phase:** 5-6 - Security + Architecture Review
**Last Updated:** 2026-04-07
