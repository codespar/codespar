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

CodeSpar implements **10 defense layers** to protect your projects, credentials, and infrastructure:

| Layer | Defense | Description |
|-------|---------|-------------|
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
