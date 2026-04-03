# CodeSpar API Reference

## Authentication

All endpoints accept the `x-org-id` header for multi-tenant org scoping. Requests without a valid org context will be rejected.

---

## Agents

| Method | Path | Query Params | Description |
|--------|------|-------------|-------------|
| GET | `/api/agents` | `?project=` | List agents, optionally filtered by project |
| GET | `/api/agents/:id` | | Agent details |
| POST | `/api/agents` | | Create a new agent |
| GET | `/api/agent-cards` | | All agent metadata (A2A discovery) |
| GET | `/api/agent-cards/:type` | | Single agent metadata by type |
| GET | `/.well-known/agent.json` | | A2A Agent Card discovery (standard endpoint) |

## A2A (Agent-to-Agent)

| Method | Path | Query Params | Description |
|--------|------|-------------|-------------|
| POST | `/a2a/tasks` | | Submit a task to an agent |
| GET | `/a2a/tasks` | `?project=`, `?limit=`, `?offset=` | List tasks with pagination and project filter |
| GET | `/a2a/tasks/:id` | | Task status and result |
| POST | `/a2a/tasks/:id/cancel` | | Cancel a running task |

## Chat

| Method | Path | Query Params | Description |
|--------|------|-------------|-------------|
| POST | `/api/chat/stream` | | Send message and receive SSE streaming response |

## Audit Trail

| Method | Path | Query Params | Description |
|--------|------|-------------|-------------|
| GET | `/api/audit` | `?limit=`, `?page=`, `?risk=`, `?project=` | List audit entries with filtering and pagination |

## Observability

| Method | Path | Query Params | Description |
|--------|------|-------------|-------------|
| GET | `/api/observability` | | Health overview across all services |
| GET | `/api/observability/vercel` | `?period=`, `?project=` | Vercel deployment metrics |
| GET | `/api/observability/railway` | | Railway services and health status |
| GET | `/api/observability/logs` | `?deploymentId=`, `?project=` | Log streaming by deployment or project |
| GET | `/api/observability/sentry` | | Sentry issues proxy (drill-down) |
| GET | `/api/observability/incidents` | `?project=` | Active incidents filtered by project |
| POST | `/api/observability/incidents/:id/acknowledge` | | Acknowledge an incident |

## Channel Routing

| Method | Path | Query Params | Description |
|--------|------|-------------|-------------|
| GET | `/api/channel-routes` | | List all configured channel routes |
| POST | `/api/channel-routes` | | Add a new channel route |
| DELETE | `/api/channel-routes/:channelType/:channelId` | | Remove a channel route |

## Integrations

| Method | Path | Query Params | Description |
|--------|------|-------------|-------------|
| GET | `/api/integrations/status` | | Integration connection status for the org |
| POST | `/api/integrations/configure` | | Configure an integration (tokens, webhooks) |
| GET | `/api/integrations/pagerduty/oncall` | | Who's currently on call |
| GET | `/api/integrations/pagerduty/incidents` | | PagerDuty incidents |
| POST | `/api/integrations/pagerduty/incidents/:id/acknowledge` | | Acknowledge a PagerDuty incident |
| GET | `/api/integrations/linear/teams` | | List Linear teams |
| GET | `/api/integrations/linear/issues` | `?teamId=`, `?search=` | List Linear issues with filters |
| POST | `/api/integrations/linear/issues` | | Create a Linear issue |

## Webhooks (Inbound)

| Method | Path | Query Params | Description |
|--------|------|-------------|-------------|
| POST | `/webhooks/vercel` | | Vercel deploy events |
| POST | `/webhooks/github` | | GitHub CI events |
| POST | `/webhooks/sentry` | | Sentry error events (HMAC verified) |
| POST | `/webhooks/deploy` | | Generic deploy webhook |

## Policies

| Method | Path | Query Params | Description |
|--------|------|-------------|-------------|
| GET | `/api/policies` | | List all governance policies |
| POST | `/api/policies` | | Create a new policy |
| PUT | `/api/policies/:id` | | Update an existing policy |
| DELETE | `/api/policies/:id` | | Delete a policy |

## Secrets

| Method | Path | Query Params | Description |
|--------|------|-------------|-------------|
| GET | `/api/secrets` | | List secrets (values are masked) |
| POST | `/api/secrets` | | Create a new secret |
| DELETE | `/api/secrets/:id` | | Delete a secret |
| PUT | `/api/secrets/:id/rotate` | | Rotate a secret's value |

## SSE Events

| Method | Path | Query Params | Description |
|--------|------|-------------|-------------|
| GET | `/api/events/stream` | | Real-time event stream (Server-Sent Events) |
