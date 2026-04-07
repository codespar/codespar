# Design Summary: prompt-guard-wiring

## Input Context (Phase 0)
**Source:** Freeform topic (S1 from OSS v1 roadmap)
**Problem:** PromptGuard.analyze() is never called in runtime. All user messages reach agents unscreened.
**Constraints:** Public repo, preserve existing 26 tests, guard must run before intent parsing, audit blocked messages, configurable threshold.

## Current Status
**Phase:** 0 - Setup (Freeform)
**Last Updated:** 2026-04-07
