<p align="center">
  <strong>code&lt;spar&gt;</strong>
</p>

<p align="center">
  <em>MIT-licensed runtime for commerce AI agents.</em>
</p>

<p align="center">
  <a href="https://github.com/codespar/codespar/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://pypi.org/project/codespar/"><img src="https://img.shields.io/pypi/v/codespar.svg?label=pip%20install%20codespar" alt="PyPI" /></a>
</p>

---

## What this is

The open-source, self-hostable agent runtime + channel adapters behind
the [CodeSpar](https://codespar.dev) platform. Channel-agnostic: agents
run just as well against WhatsApp, Slack, Discord, Telegram, the web,
or plain HTTP as they do against a terminal. The managed tier
([codespar-enterprise](https://github.com/codespar/codespar-enterprise),
private) registers commerce-governance capabilities (programmable
wallet, policy engine, compliance certifications) against the plugin
hooks exposed here.

CodeSpar's thesis: the platform is generic, and **LATAM commerce** is
its sharpest application. The MIT layer stays MIT forever — no rate
limits, no feature gates, no telemetry walls. Revenue lives above it
in managed hosting + commerce governance, not on `npm install`.

## Use it for

- **Agents that transact on LATAM rails** — Pix, PSPs, NF-e, shipping,
  WhatsApp Business — without rebuilding the plumbing every team.
- **Any commerce/ops agent on any channel** — pair the runtime with
  one of the MCP catalogs and you ship in an afternoon.
- **Self-hosting** — no phone-home, fully operable without codespar
  infrastructure. Docker Compose included.

## Quick start

Install the SDK (pip or npm) and create a session:

```bash
pip install codespar
```

```python
from codespar import CodeSpar

cs = CodeSpar(api_key="csk_live_...")
session = cs.create("user_123", preset="brazilian")
print(session.send("Charge R$500 via Pix").message)
```

Or self-host the runtime:

```bash
git clone https://github.com/codespar/codespar
cd codespar
docker compose up          # Postgres + Redis + core
docker compose -f docker-compose.yml -f docker-compose.whatsapp.yml up   # + WhatsApp
```

Docs: https://docs.codespar.dev

## What's in the box

- **Runtime**: agent supervisor, message router, task queue, vector
  memory, audit log with hash-chain integrity.
- **Channel adapters**: WhatsApp (Evolution API), Slack (Bolt), Telegram
  (grammy), Discord (discord.js), CLI REPL.
- **Identity + RBAC**: cross-channel user mapping, 6 roles, ABAC
  policies, approval quorum.
- **Storage**: PostgreSQL (Drizzle) + Redis, with a file-storage fallback
  for single-tenant installs.
- **Plugin hooks**: `PolicyHook`, `ObservabilityHook`, `SecretsHook`,
  `IntegrationHook` — the managed tier's governance layer plugs in
  here; public core never imports enterprise packages.
- **Tenancy**: Organization → Project, mirroring the enterprise
  contract. `x-codespar-project` header on every `/v1` route; optional
  on inbound channel messages via `channel_links` bindings. See
  [`docs/projects-roadmap.md`](docs/projects-roadmap.md) for port status.

## Channel support

| Channel | Status |
|---------|--------|
| WhatsApp (Evolution API v2.3.7) | ✅ Working |
| Slack (Socket Mode, app_mention + DMs) | ✅ Working |
| Telegram (grammy) | ✅ Working |
| Discord (discord.js) | ✅ Working |
| CLI REPL (stdin/stdout) | ✅ Working |
| Web chat (streaming SSE) | ✅ Working |
| Email / Voice / SMS | Planned |

Channels are composable capabilities — no single channel is a
prerequisite. An agent that speaks only HTTP is a first-class citizen.

## Managed tier

If you don't want to self-host the runtime, the managed tier hosts it
for you, with programmable wallet + policy engine + commerce-specific
observability + fiscal-compliance certifications on top. Sign up at
[codespar.dev](https://codespar.dev) or read the
[VISION](https://github.com/codespar/codespar-web/blob/main/docs/visions/VISION-codespar.md)
for the full pitch.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). The `.codespar-ready` MCP
servers in [mcp-dev-latam](https://github.com/codespar/mcp-dev-latam)
are a good place to add provider coverage without touching runtime
internals.

## License

MIT — see [LICENSE](./LICENSE). The five-point MIT commitment in VISION
is non-negotiable: no phone-home, no feature gates on the MIT layer, no
telemetry that restricts functionality.
