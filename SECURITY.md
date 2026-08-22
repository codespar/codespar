# Security Policy

## Reporting Vulnerabilities

If you discover a security vulnerability in CodeSpar, please report it responsibly:

- **Email:** [security@codespar.dev](mailto:security@codespar.dev)
- **Acknowledgment:** within 48 hours
- **Coordinated disclosure:** 90-day window before public disclosure
- **Do NOT open public issues** for security vulnerabilities

We take all reports seriously. If the issue is confirmed, we will release a patch and credit you in the release notes (unless you prefer to remain anonymous).

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 0.x     | Yes (current)      |

As the project is in early development, all `0.x` releases receive security patches. Once we reach `1.0`, we will maintain a formal support window.

## Security Model

CodeSpar implements **11 defense layers** to protect your projects, credentials, and infrastructure:

| Layer | Defense | Description |
|-------|---------|-------------|
| 0 | **API Authentication** | `/api/*`, `/sessions/*` and `/a2a/*` require a bearer token. There is no unauthenticated mode: the runtime generates and persists a credential on first boot when the operator supplies none, so requiring it costs an unattended install nothing. Exceptions are `/health`, the A2A card at `/.well-known/agent.json`, the OAuth install/callback routes, and the provider webhook routes — see the note below, which describes what webhooks do and do not verify. |
| 1 | **Message Filter** | Only processes `@mention` commands and direct messages. All other messages are ignored. |
| 2 | **Channel Config** | Agents ignore messages from unconfigured channels. No implicit trust. |
| 3 | **Identity Resolution** | Maps channel-specific user IDs to a unified identity. Prevents impersonation across platforms. |
| 4 | **RBAC** | 6 roles with escalating permissions: `read-only`, `developer`, `reviewer`, `deployer`, `owner`, `emergency_admin`. |
| 5 | **ABAC Policies** | Attribute-based access control: time windows, environment restrictions, quorum requirements for sensitive operations. |
| 6 | **Agent Sandboxing** | Each agent is scoped to a single project. No cross-project data access. |
| 7 | **Prompt Injection Defense** | Pattern blocklist, risk classifier, and template isolation prevent prompt injection attacks against the AI layer. |
| 8 | **Execution Sandbox** | Every coding task runs in an isolated Docker container with restricted filesystem and network access. |
| 9 | **Output Validation** | All agent responses are scanned for leaked secrets, API keys, and credentials before being sent to channels. |
| 10 | **Audit Trail** | Immutable hash-chained log of all actions. 1-year retention. Tamper-evident by design. |

### Webhook routes: what is and is not verified

Be precise about this one, because an earlier version of this document was not.

`/webhooks/github`, `/webhooks/vercel`, `/webhooks/sentry` and
`/webhooks/deploy` are **not** covered by the bearer credential. They are meant
to be authenticated by the provider's HMAC signature, and they are — **but only
once a secret is configured for that provider.**

With no secret configured, which is the state of a fresh install, the default
is to **accept the payload without verifying anything** and log a warning. An
accepted payload is written to the audit log, broadcast to SSE clients, and
dispatched to the registered event handlers, so an unauthenticated caller can
inject fabricated CI and deploy events into a runtime that acts on them.

`WEBHOOK_STRICT_MODE=true` changes that default to reject unsigned requests
with `401`. It is **off** by default, and note that `WHATSAPP_WEBHOOK_STRICT_MODE`
is a different variable governing a different route.

The runtime now provisions that secret itself. A webhook it registers is
created **with** a signing secret it generates and stores, and webhooks
registered by earlier releases are repaired at startup, so GitHub deliveries
arrive signed and verifiable without anyone configuring anything. That is what
makes strict mode usable at all: before it, turning strict mode on rejected the
integration the runtime had set up for itself, and setting
`GITHUB_WEBHOOK_SECRET` by hand made things worse rather than better, because
GitHub had never been told the value.

What has **not** changed is the default: unsigned deliveries are still accepted
unless `WEBHOOK_STRICT_MODE=true`. Flipping that default is a separate,
deliberate decision, tracked in
[#138](https://github.com/codespar/codespar/issues/138). Until it is flipped,
these four routes still accept unverified input on a default install, so
restrict who can reach them at the network layer.

Vercel and Sentry webhooks are created by you in those providers' dashboards,
not by this runtime, so their secrets stay yours to configure.

## Safety Guardrails

Regardless of an agent's autonomy level, the following actions **always** require explicit human approval:

- Production deployments
- Data migrations
- Security-sensitive changes (permissions, secrets, auth config)
- Infrastructure modifications

These guardrails cannot be overridden by autonomy level settings.

## Best Practices for Operators

- **Rotate API keys** regularly (Anthropic, GitHub, channel tokens).
- **Use the lowest autonomy level** that meets your needs (L1 Notify is the default).
- **Review the audit trail** periodically for unexpected agent actions.
- **Restrict channel access** — only configure channels where your team actually works.
- **Keep CodeSpar updated** to receive the latest security patches.
