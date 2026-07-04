# @codespar/core

The MIT-licensed agent runtime behind [CodeSpar](https://codespar.dev).
This package is the engine the rest of the repo assembles: sessions,
the chat loop, message routing, the MCP bridge, storage, and the plugin
hooks that the managed tier registers its commerce governance against.
The channel adapters (WhatsApp, Slack, Telegram, Discord, CLI) live in
`packages/channels` and plug into the router exposed here.

## Quick start

Run the whole runtime from the repo root (Postgres + Redis + core):

```bash
git clone https://github.com/codespar/codespar
cd codespar
docker compose up
docker compose -f docker-compose.yml -f docker-compose.whatsapp.yml up   # + WhatsApp
```

Or talk to a hosted runtime through the SDK:

```bash
pip install codespar
```

```python
from codespar import CodeSpar

cs = CodeSpar(api_key="csk_live_...")
session = cs.create("user_123", preset="brazilian")
print(session.send("Charge R$500 via Pix").message)
```

The self-host path and the SDK path hit the same session routes served
by this package. See the [root README](../../README.md) for the full
walkthrough.

## MCP bridge

`POST /sessions/:id/execute` routes any tool call whose name contains a
`/` (for example `asaas/charge`) to a spawned stdio MCP server process.
The spawn command for a prefix comes from one of three configuration
surfaces, checked in this order:

1. **Inline `server_specs`** in the `POST /sessions` body. Preferred for
   SDK callers; the session is self-contained, no file on disk.
2. **`CODESPAR_MCP_SERVERS_PATH`** env var pointing at a config file
   anywhere on disk. Useful under systemd or in containers.
3. **`mcp-servers.json`** in the runtime's working directory. Fallback
   for ad-hoc local runs; copy `examples/mcp-servers.json` and edit.

If none are set, the registry is empty: `prefix/tool` calls return
`Tool not registered`, the runtime does not crash, and built-ins keep
working. Full details, payload shapes, and the end-to-end check
(`scripts/validate-bridge.sh`) are in the
[root README](../../README.md#mcp-bridge).

## Test mode

`CODESPAR_TEST_MODE_ENABLED=true` puts the runtime in test mode: every
external tool dispatch must match a mock declared on the session
(`mocks` on `POST /sessions`), and the bridge is never reached without
one. With the flag off (the default), `mocks` is rejected with HTTP 501
and every dispatch goes to the real bridge. Mocks are single-shot
objects or stateful arrays, held in process-local memory. Wire shapes
and error envelopes match the managed runtime byte for byte. See
[docs/test-mode.md](../../docs/test-mode.md) for the longer write-up.

## Plugin hooks

The core never imports enterprise packages. Instead it calls hooks at
fixed points in the agent lifecycle, and anything (the managed tier, a
community plugin, your own code) can register against them. Defined in
[`src/plugins/types.ts`](./src/plugins/types.ts):

- **`PolicyHook`**: called before an action executes; returns an
  allow/deny decision, optionally requiring human approval.
- **`ObservabilityHook`**: called after execution with latency, cost,
  and token metrics.
- **`SecretsHook`**: called when the agent needs credentials, keyed by
  tenant.
- **`IntegrationHook`**: webhook connectors for external services
  (signature verification, health checks).
- **`MetaToolHook`**: the meta-tool registration seam. Defined
  canonically in `@codespar/types` and re-exported here; register a
  named higher-level tool via `pluginRegistry.registerMetaTool(...)`
  and the runtime dispatches it by name through the standard execute
  path. `examples/meta-tool-adapter` is the canonical registrant to
  copy.

## License

MIT, same as the repo: no phone-home, no feature gates, no telemetry
walls. If you don't want to self-host, the managed tier at
[codespar.dev](https://codespar.dev) runs this runtime for you with the
programmable wallet, policy engine, and compliance layer registered on
the hooks above.
