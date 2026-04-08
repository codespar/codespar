# Design Summary: deploy-webhook-auth

## Input Context (Phase 0)
**Source PRD:** docs/prds/PRD-deploy-webhook-auth.md
**Problem (implementation framing):** POST /webhooks/deploy is the only webhook handler without HMAC signature verification. The shared webhook-auth.ts module and the org-scoped secret resolution pattern (used by Vercel, Sentry, GitHub handlers) already exist -- the deploy handler just needs to adopt them.

## Current Status
**Phase:** 6 - Final Review
**Last Updated:** 2026-04-07
